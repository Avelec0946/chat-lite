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
  // Stamp current conversation with updatedAt for merge resolution
  const conv = state.conversations.find(c => c.id === state.currentId);
  if (conv) conv.updatedAt = Date.now();
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
  return { thinkingEnabled: true, apiKey: '', fontSize: '15', lineSpacing: '1.6' };
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
  // Merge server + localStorage data by timestamp (newest wins)
  loadData(); // Load localStorage first as baseline
  try {
    const resp = await fetch('/api/load');
    const data = await resp.json();
    if (data.conversations && data.conversations.length > 0) {
      // Merge: for each server conversation, keep the newer version
      const localMap = {};
      for (const c of state.conversations) { localMap[c.id] = c; }
      for (const sc of data.conversations) {
        const lc = localMap[sc.id];
        if (!lc) {
          // Server has a conversation that's not local — add it
          state.conversations.push(sc);
        } else if ((sc.updatedAt || 0) > (lc.updatedAt || 0)) {
          // Server has newer version — replace local
          const idx = state.conversations.findIndex(c => c.id === sc.id);
          if (idx >= 0) state.conversations[idx] = sc;
        }
        // else: local is newer, keep it
      }
      // If server has a currentId we don't have, use it
      if (data.currentId && !state.conversations.find(c => c.id === data.currentId)) {
        state.currentId = data.currentId;
      }
    }
  } catch(e) {
    // Server not available — localStorage baseline is already loaded
  }
  // Migrate any old-format conversations
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
  $('conv-search-input').addEventListener('input', renderSidebar);
  $('btn-settings').addEventListener('click', () => toggleSettings(true));
  $('btn-close-settings').addEventListener('click', () => toggleSettings(false));
  $('btn-branch').addEventListener('click', () => { openBranchDrawer(); setTimeout(applyBranchCenter, 200); });
  $('btn-close-branch').addEventListener('click', closeBranchDrawer);
  // Branch search
  $('branch-search-input').addEventListener('input', doBranchSearch);
  $('btn-search-prev').addEventListener('click', () => navigateToSearchResult(-1));
  $('btn-search-next').addEventListener('click', () => navigateToSearchResult(1));
  $('btn-zoom-in').addEventListener('click', () => { branchZoom = branchZoom + 0.08; applyBranchZoom(); updateZoomInput(); });
  $('btn-zoom-out').addEventListener('click', () => { branchZoom = Math.max(branchZoom - 0.08, 0.1); applyBranchZoom(); updateZoomInput(); });
  $('zoom-input').addEventListener('change', () => {
    const v = parseInt($('zoom-input').value) / 100;
    if (v > 0) { branchZoom = v; applyBranchZoom(); }
    updateZoomInput();
  });
  $('zoom-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('zoom-input').blur(); });
  $('btn-export').addEventListener('click', exportConversation);
  $('btn-import').addEventListener('click', () => { document.getElementById('import-file-input').click(); });
  document.getElementById('import-file-input').addEventListener('change', importConversation);
  document.querySelector('#branch-drawer .branch-drawer-backdrop').addEventListener('click', closeBranchDrawer);

  $('btn-save-settings').addEventListener('click', saveSettingsHandler);
  settingsPanel.querySelector('.settings-backdrop').addEventListener('click', () => toggleSettings(false));
  sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('hidden'));
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
  const query = (document.getElementById('conv-search-input')?.value || '').trim().toLowerCase();
  const filtered = query 
    ? state.conversations.filter(c => c.title.toLowerCase().includes(query))
    : state.conversations;
  convList.innerHTML = filtered.map(c =>
    `<div class="conv-item${c.id === state.currentId ? ' active' : ''}" data-id="${c.id}">
      <span class="conv-title">${escapeHtml(c.title)}</span>
      <button class="del-btn" data-id="${c.id}" title="删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
    </div>`
  ).join('');

  // Click to switch
  convList.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('del-btn')) return;
      if (e.target.tagName === 'INPUT') return;
      switchConversation(el.dataset.id);
    });
  });

  // Rename conversation by clicking its title
  convList.querySelectorAll('.conv-title').forEach(span => {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      const convItem = span.closest('.conv-item');
      const id = convItem.dataset.id;
      const conv = state.conversations.find(c => c.id === id);
      if (!conv) return;
      const oldTitle = conv.title;
      const input = document.createElement('input');
      input.className = 'conv-rename-input';
      input.value = oldTitle;
      input.addEventListener('blur', () => {
        conv.title = input.value.trim() || oldTitle;
        save();
        renderSidebar();
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = oldTitle; input.blur(); }
      });
      span.innerHTML = '';
      span.appendChild(input);
      input.focus();
      input.select();
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
  state.conversations.push(conv);
  state.currentId = conv.id;
  save();
  renderSidebar();
  renderMessages();
  modelSelect.value = conv.model;
  chatInput.focus();
}

// ===== Breadcrumb =====
function renderBreadcrumb(conv) {
  const bar = document.getElementById('breadcrumb-bar');
  if (!bar) return;
  const chain = getActiveChain(conv);
  const display = chain.filter(m => m && m.role !== 'system');
  if (display.length < 1) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  let html = '';
  display.forEach((m, i) => {
    const label = m.title || m.content.substring(0, 20) + (m.content.length > 20 ? '...' : '') || '(空)';
    const icon = m.role === 'user' ? '👤' : '🤖';
    const isLast = i === display.length - 1;
    // Show sibling count if this is the last node and parent has multiple children
    const children = m.children || [];
    const siblingLabel = (isLast && children.length > 1) ? ` +${children.length - 1}` : '';
    html += `<span class="breadcrumb-segment${isLast ? ' active' : ''}" data-id="${m.id}">${icon} ${escapeHtml(label)}${siblingLabel ? `<span style="font-size:10px;color:var(--text2)">${siblingLabel}</span>` : ''}</span>`;
    if (!isLast) html += '<span class="breadcrumb-sep">▸</span>';
  });
  bar.innerHTML = html;
  bar.querySelectorAll('.breadcrumb-segment').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const newPath = getBranchPath(conv, id);
      conv.activePath = newPath;
      save();
      renderMessages();
      renderBreadcrumb(conv);
    });
  });
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
        ${renderSiblingArrows(msg, conv)}
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

  scrollToBottom();
}

// Sibling navigation (branch switching)
function renderSiblingArrows(msg, conv) {
  const parent = getMsg(conv, msg.parentId);
  if (!parent || !parent.children || parent.children.length <= 1) return '';
  const siblings = parent.children;
  const idx = siblings.indexOf(msg.id);
  if (idx < 0) return '';
  return `<span class="version-arrows branch-nav">
    <button class="version-arrow" onclick="switchSibling('${msg.id}', -1)" ${idx === 0 ? 'disabled' : ''}>◀</button>
    <span class="version-label">${idx + 1}/${siblings.length}</span>
    <button class="version-arrow" onclick="switchSibling('${msg.id}', 1)" ${idx >= siblings.length - 1 ? 'disabled' : ''}>▶</button>
  </span>`;
}

window.switchSibling = function(currentId, direction) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, currentId);
  if (!msg) return;
  const parent = getMsg(conv, msg.parentId);
  if (!parent || !parent.children) return;
  const siblings = parent.children;
  const idx = siblings.indexOf(currentId);
  if (idx < 0) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= siblings.length) return;
  
  const newId = siblings[newIdx];
  const pathIdx = conv.activePath.indexOf(currentId);
  if (pathIdx >= 0) {
    conv.activePath[pathIdx] = newId;
    // Truncate any subsequent messages in activePath (they belong to old branch)
    conv.activePath = conv.activePath.slice(0, pathIdx + 1);
    // Append the new branch's children path
    appendChildPath(conv, newId);
  }
  save();
  renderMessages();
  renderBreadcrumb(conv);
};

function appendChildPath(conv, fromId) {
  const msg = conv.messageMap[fromId];
  if (!msg || !msg.children || msg.children.length === 0) return;
  // Follow the first child (preferred path)
  const nextId = msg.children[0];
  conv.activePath.push(nextId);
  appendChildPath(conv, nextId);
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
  if (conv.systemPrompt) {
    sysParts.push(conv.systemPrompt);
  }
  if (conv.userIdentity) {
    sysParts.push('用户身份：' + conv.userIdentity);
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

// ===== Branch drawer =====
function openBranchDrawer() {
  const conv = currentConv();
  if (!conv) return;
  updateZoomInput();
  const drawer = document.getElementById('branch-drawer');
  const tree = document.getElementById('branch-tree');
  const info = document.getElementById('branch-info');
  drawer.style.display = 'flex';

  const totalWords = computeBranchWords(conv, conv.rootId);
  const chainLen = getActiveChain(conv).filter(m => m && m.role !== 'system').length;
  info.textContent = `分支总览 — ${chainLen} 条消息 · ${totalWords} 字`;

  tree.innerHTML = renderTreeSVG(conv);
  applyBranchZoom();
  initPinchZoom();
}

let branchZoom = 1;

function closeBranchDrawer() {
  document.getElementById('branch-drawer').style.display = 'none';
  removePinchListeners();
  branchSearchResults = [];
  branchSearchIdx = -1;
  document.getElementById('branch-search-input').value = '';
  document.getElementById('branch-search-info').textContent = '';
}

// ===== Branch search =====
let branchSearchResults = [];
let branchSearchIdx = -1;

function doBranchSearch() {
  const input = document.getElementById('branch-search-input');
  const query = (input?.value || '').trim().toLowerCase();
  const info = document.getElementById('branch-search-info');
  const conv = currentConv();
  if (!query || !conv) {
    branchSearchResults = []; branchSearchIdx = -1;
    clearSearchHighlights();
    if (info) info.textContent = '';
    return;
  }
  // Search all messages in the conversation
  branchSearchResults = [];
  for (const [id, msg] of Object.entries(conv.messageMap || {})) {
    if (msg.role === 'system') continue;
    const content = (msg.content || '').toLowerCase();
    const title = (msg.title || '').toLowerCase();
    const idx = content.indexOf(query);
    if (idx >= 0) {
      branchSearchResults.push({ id, pos: idx, text: content.substring(Math.max(0,idx-20), idx+query.length+40) });
    }
  }
  branchSearchIdx = branchSearchResults.length > 0 ? 0 : -1;
  if (info) info.textContent = branchSearchResults.length > 0 
    ? `${branchSearchResults.length} 条` : '无结果';
  updateSearchHighlights();
  renderSearchResults();
  if (branchSearchIdx >= 0) navigateToSearchResult(0);
}

function renderSearchResults() {
  const container = document.getElementById('branch-search-results');
  if (!container) return;
  if (branchSearchResults.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'block';
  const query = (document.getElementById('branch-search-input')?.value || '').trim();
  container.innerHTML = branchSearchResults.map((r, i) => {
    const conv = currentConv();
    const msg = conv?.messageMap?.[r.id];
    const role = msg?.role === 'user' ? '👤' : '🤖';
    const text = escapeHtml(r.text);
    const hl = text.replace(new RegExp(escapeRegex(query), 'gi'), m => `<mark class="result-highlight">${m}</mark>`);
    return `<div class="branch-search-result" data-idx="${i}" onclick="jumpToSearchResult(${i})">
      <span class="result-role">${role}</span>
      <span class="result-text">${hl}</span>
    </div>`;
  }).join('');
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

window.jumpToSearchResult = function(idx) {
  branchSearchIdx = idx;
  navigateToSearchResult(0);
};

function updateSearchHighlights() {
  const svg = document.querySelector('.branch-svg');
  if (!svg) return;
  // Clear old highlights
  svg.querySelectorAll('.search-highlight').forEach(el => el.remove());
  // Add new highlights
  const resultIds = new Set(branchSearchResults.map(r => r.id));
  svg.querySelectorAll('.tree-node').forEach(g => {
    const onclick = g.getAttribute('onclick') || '';
    const idMatch = onclick.match(/'([^']+)'/);
    if (idMatch && resultIds.has(idMatch[1])) {
      const rect = g.querySelector('rect');
      if (rect) {
        const hl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hl.setAttribute('x', rect.getAttribute('x'));
        hl.setAttribute('y', rect.getAttribute('y'));
        hl.setAttribute('width', rect.getAttribute('width'));
        hl.setAttribute('height', rect.getAttribute('height'));
        hl.setAttribute('rx', '8');
        hl.setAttribute('fill', 'none');
        hl.setAttribute('stroke', '#f59e0b');
        hl.setAttribute('stroke-width', '3');
        hl.classList.add('search-highlight');
        g.appendChild(hl);
      }
    }
  });
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-highlight').forEach(el => el.remove());
}

function navigateToSearchResult(dir) {
  if (branchSearchResults.length === 0) return;
  branchSearchIdx = (branchSearchIdx + dir + branchSearchResults.length) % branchSearchResults.length;
  const result = branchSearchResults[branchSearchIdx];
  const info = document.getElementById('branch-search-info');
  if (info) info.textContent = `${branchSearchIdx + 1}/${branchSearchResults.length}`;
  // Find and scroll to the node in SVG
  const container = document.querySelector('.branch-drawer-body');
  const svg = document.querySelector('.branch-svg');
  if (!container || !svg) return;
  const nodes = svg.querySelectorAll('.tree-node');
  for (const g of nodes) {
    const onclick = g.getAttribute('onclick') || '';
    if (onclick.includes(result.id)) {
      // Scroll the container to make this node visible
      const transform = g.getAttribute('transform') || '';
      const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
      if (match) {
        const tx = parseFloat(match[1]), ty = parseFloat(match[2]);
        container.scrollTop = Math.max(0, ty * branchZoom - container.clientHeight / 2);
        container.scrollLeft = Math.max(0, tx * branchZoom - container.clientWidth / 2);
      }
      // Flash highlight
      g.style.outline = '3px solid #f59e0b';
      g.style.outlineOffset = '2px';
      g.style.zIndex = '10';
      setTimeout(() => { g.style.outline = ''; g.style.outlineOffset = ''; g.style.zIndex = ''; }, 1500);
      break;
    }
  }
}

// Pinch-zoom for mobile
let pinchState = null;
function initPinchZoom() {
  const container = document.querySelector('.branch-drawer-body');
  if (!container) return;
  container.addEventListener('touchstart', onPinchStart, {passive:false});
  container.addEventListener('touchmove', onPinchMove, {passive:false});
  container.addEventListener('touchend', onPinchEnd);
  // Desktop: Alt+wheel zoom, mouse drag pan
  container.addEventListener('wheel', onWheelZoom, {passive:false});
  container.addEventListener('mousedown', onMouseDown);
}

function removePinchListeners() {
  const container = document.querySelector('.branch-drawer-body');
  if (!container) return;
  container.removeEventListener('touchstart', onPinchStart);
  container.removeEventListener('touchmove', onPinchMove);
  container.removeEventListener('touchend', onPinchEnd);
  container.removeEventListener('wheel', onWheelZoom);
  container.removeEventListener('mousedown', onMouseDown);
  pinchState = null;
}

// Alt+wheel zoom on desktop
function onWheelZoom(e) {
  if (!e.altKey && !e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.05 : 0.05;
  const container = e.currentTarget;
  const rect = container.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const svgX = (container.scrollLeft + mx) / branchZoom;
  const svgY = (container.scrollTop + my) / branchZoom;
  branchZoom = Math.max(0.1, Math.min(branchZoom + delta, 50));
  applyBranchZoom();
  updateZoomInput();
  container.scrollLeft = svgX * branchZoom - mx;
  container.scrollTop = svgY * branchZoom - my;
}

// Mouse drag to pan on desktop
let mouseDrag = null;
function onMouseDown(e) {
  if (e.button !== 0) return;
  mouseDrag = { x: e.clientX, y: e.clientY, sx: e.currentTarget.scrollLeft, sy: e.currentTarget.scrollTop };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}
function onMouseMove(e) {
  if (!mouseDrag) return;
  const dx = mouseDrag.x - e.clientX, dy = mouseDrag.y - e.clientY;
  document.querySelector('.branch-drawer-body').scrollLeft = mouseDrag.sx + dx;
  document.querySelector('.branch-drawer-body').scrollTop = mouseDrag.sy + dy;
}
function onMouseUp() { mouseDrag = null; window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); }

function onPinchStart(e) {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const t1 = e.touches[0], t2 = e.touches[1];
  pinchState = {
    dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
    midX: (t1.clientX + t2.clientX) / 2,
    midY: (t1.clientY + t2.clientY) / 2,
    startZoom: branchZoom,
    container: document.querySelector('.branch-drawer-body'),
    svg: document.querySelector('.branch-svg')
  };
}

function onPinchMove(e) {
  if (!pinchState || e.touches.length !== 2) return;
  e.preventDefault();
  const t1 = e.touches[0], t2 = e.touches[1];
  const newDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  // Dead zone: skip if fingers barely moved (< 2px change)
  if (Math.abs(newDist - pinchState.dist) < 2) return;
  const scale = newDist / pinchState.dist;
  const newZoom = Math.max(0.1, Math.min(pinchState.startZoom * scale, 50));
  
  // Use the CURRENT pinch midpoint, not the initial one
  const curMidX = (t1.clientX + t2.clientX) / 2;
  const curMidY = (t1.clientY + t2.clientY) / 2;
  
  // Record the SVG coordinate under the CURRENT pinch midpoint BEFORE zoom
  const container = pinchState.container;
  const containerRect = container.getBoundingClientRect();
  const midScreenX = curMidX - containerRect.left;
  const midScreenY = curMidY - containerRect.top;
  const svgX = (container.scrollLeft + midScreenX) / pinchState.startZoom;
  const svgY = (container.scrollTop + midScreenY) / pinchState.startZoom;
  
  branchZoom = newZoom;
  applyBranchZoom();
  updateZoomInput();
  
  // After zoom, reposition so the same SVG coordinate is under the same screen position
  container.scrollLeft = svgX * newZoom - midScreenX;
  container.scrollTop = svgY * newZoom - midScreenY;
  pinchState.startZoom = newZoom;
}

function onPinchEnd() {
  pinchState = null;
}

// ===== SVG Tree Layout & Rendering =====
function renderTreeSVG(conv) {
  const NODE_W = 150, NODE_H = 50;
  const H_GAP = 24, V_GAP = 32;
  
  // Step 1: collect non-system nodes into levels, compute subtree widths
  const levels = {}; // depth -> [{id, msg, subtreeW}]
  const parentOf = {}; // childId -> parentId
  
  function measure(nodeId, depth) {
    const msg = conv.messageMap[nodeId];
    if (!msg) return 0;
    const isHidden = msg.role === 'system' && msg.parentId !== null;
    const children = msg.children || [];
    let childW = 0;
    for (const cid of children) {
      parentOf[cid] = nodeId;
      const w = measure(cid, isHidden ? depth : depth + 1);
      childW += w + (w > 0 ? H_GAP : 0);
    }
    childW = Math.max(0, childW - H_GAP);
    if (!isHidden) {
      if (!levels[depth]) levels[depth] = [];
      levels[depth].push({ id: nodeId, msg, subtreeW: Math.max(childW, NODE_W) });
    }
    return Math.max(childW, NODE_W);
  }
  
  measure(conv.rootId, 0);
  
  const maxDepth = Math.max(...Object.keys(levels).map(Number), 0);
  if (maxDepth === 0) return '<div style="padding:20px;color:var(--text2)">暂无分支</div>';
  
  // Step 2: assign x,y positions
  const positions = {};
  for (let d = 0; d <= maxDepth; d++) {
    const nodes = levels[d] || [];
    if (nodes.length === 0) continue;
    // Spread nodes evenly, using subtree widths
    const totalW = nodes.reduce((sum, n) => sum + n.subtreeW, 0) + (nodes.length - 1) * H_GAP;
    let x = 0;
    for (const node of nodes) {
      positions[node.id] = {
        x: x + node.subtreeW / 2,
        y: d * (NODE_H + V_GAP) + NODE_H / 2
      };
      x += node.subtreeW + H_GAP;
    }
  }
  
  // Step 3: build SVG
  const svgW = Math.max(
    Object.values(positions).reduce((max, p) => Math.max(max, p.x + NODE_W/2 + 20), 0),
    300
  );
  const svgH = (maxDepth + 1) * (NODE_H + V_GAP) + 20;
  
  let svg = `<svg class="branch-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">`;
  svg += `<defs><filter id="shadow"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.1"/></filter></defs>`;
  
  // Draw edges
  for (const [childId, parentId] of Object.entries(parentOf)) {
    const pp = positions[parentId];
    const cp = positions[childId];
    if (!pp || !cp) continue;
    const pMsg = conv.messageMap[parentId];
    if (pMsg && pMsg.role === 'system' && !pMsg.parentId) continue; // skip root edges
    const isActiveEdge = conv.activePath.includes(parentId) && conv.activePath.includes(childId);
    svg += `<line x1="${pp.x}" y1="${pp.y + NODE_H/2}" x2="${cp.x}" y2="${cp.y - NODE_H/2}" 
      stroke="${isActiveEdge ? 'var(--primary)' : 'var(--text2)'}" stroke-width="${isActiveEdge ? 2 : 1}" opacity="${isActiveEdge ? 0.8 : 0.3}"/>`;
  }
  
  // Draw nodes
  for (const [nodeId, pos] of Object.entries(positions)) {
    const msg = conv.messageMap[nodeId];
    if (!msg) continue;
    const isActive = conv.activePath.includes(nodeId);
    const hasChildren = (msg.children || []).length > 0;
    const icon = msg.role === 'user' ? '👤' : '🤖';
    const rawTitle = (msg.title || msg.content || '');
    const cleanTitle = (typeof rawTitle === 'string' ? rawTitle : '').replace(/\s+/g, ' ').trim() || '(空)';
    // Truncate by visual width: CJK ≈ 2 units, ASCII ≈ 1 unit
    let title = '', w = 0, maxW = 16;
    for (const ch of cleanTitle) { 
      const cw = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
      if (w + cw > maxW) { title += '…'; break; }
      title += ch; w += cw;
    }
    const wc = msg.wordCount || countWords(msg.content || '');
    
    const bx = pos.x - NODE_W/2;
    const by = pos.y - NODE_H/2;
    const fillColor = msg.color || (isActive ? 'var(--primary)' : 'var(--bg2)');
    
    svg += `<g class="tree-node" onclick="svgNodeClick('${nodeId}')" oncontextmenu="event.preventDefault();svgNodeRename('${nodeId}')" transform="translate(${bx},${by})">
      <rect x="0" y="0" width="${NODE_W}" height="${NODE_H}" rx="8" 
        fill="${fillColor}" 
        stroke="${isActive ? 'var(--primary)' : 'var(--border)'}" 
        stroke-width="${isActive ? 1.5 : 1}" filter="url(#shadow)"/>
      <text x="8" y="18" font-size="11" font-weight="${isActive ? 'bold' : 'normal'}" 
        fill="${isActive ? '#fff' : 'var(--text)'}" font-family="inherit">${icon} ${escapeSvg(title)}</text>
      <text x="8" y="36" font-size="10" fill="${isActive ? 'rgba(255,255,255,0.7)' : 'var(--text2)'}" font-family="inherit">${wc}字${hasChildren ? ' ▾' : ''}</text>
    </g>`;
  }
  
  svg += '</svg>';
  return svg;
}

function escapeSvg(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.svgNodeClick = function(nodeId) {
  const conv = currentConv();
  if (!conv) return;
  const newPath = getBranchPath(conv, nodeId);
  conv.activePath = newPath;
  save();
  renderMessages();
  renderBreadcrumb(conv);
  closeBranchDrawer();
};

function applyBranchZoom() {
  const svg = document.querySelector('.branch-svg');
  if (!svg) return;
  const origW = parseInt(svg.getAttribute('data-orig-w') || svg.getAttribute('width'));
  const origH = parseInt(svg.getAttribute('data-orig-h') || svg.getAttribute('height'));
  if (!svg.hasAttribute('data-orig-w')) {
    svg.setAttribute('data-orig-w', origW);
    svg.setAttribute('data-orig-h', origH);
  }
  svg.setAttribute('width', Math.round(origW * branchZoom));
  svg.setAttribute('height', Math.round(origH * branchZoom));
}
function applyBranchCenter() {
  const container = document.querySelector('.branch-drawer-body');
  const svg = document.querySelector('.branch-svg');
  if (!container || !svg) return;
  const rootNode = svg.querySelector('.tree-node');
  if (!rootNode) return;
  const transformAttr = rootNode.getAttribute('transform') || '';
  const match = transformAttr.match(/translate\(([^,]+),\s*([^)]+)\)/);
  const tx = parseFloat(match?.[1]) || 0;
  const ty = parseFloat(match?.[2]) || 0;
  container.scrollLeft = Math.max(0, (tx + 90) * branchZoom - container.clientWidth / 2);
  container.scrollTop = Math.max(0, (ty + 22) * branchZoom - container.clientHeight / 2);
}

function updateZoomInput() {
  const inp = document.getElementById('zoom-input');
  if (inp) inp.value = Math.round(branchZoom * 100);
}

const NODE_COLORS = [
  { name: '默认', value: null },
  { name: '红', value: '#ef4444' },
  { name: '绿', value: '#22c55e' },
  { name: '蓝', value: '#3b82f6' },
  { name: '黄', value: '#eab308' },
  { name: '紫', value: '#a855f7' },
  { name: '橙', value: '#f97316' },
  { name: '灰', value: '#6b7280' },
];

window.svgNodeRename = function(nodeId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, nodeId);
  if (!msg) return;
  const curColor = msg.color ? NODE_COLORS.findIndex(c => c.value === msg.color) : 0;
  const input = prompt(
    '右键菜单：\n• 选色: 输入 0-7 (当前:' + NODE_COLORS[curColor].name + ')\n• 改名: 直接输入新名称\n\n0.默认 1.红 2.绿 3.蓝 4.黄 5.紫 6.橙 7.灰',
    msg.title || ''
  );
  if (input === null) return;
  const n = parseInt(input);
  if (!isNaN(n) && n >= 0 && n <= 7) {
    msg.color = NODE_COLORS[n].value;
    save();
    openBranchDrawer();
    return;
  }
  if (input.trim()) {
    msg.title = input.trim();
    save();
    openBranchDrawer();
    renderMessages();
  }
};

window.svgNodeColor = function(nodeId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, nodeId);
  if (!msg) return;
  const colorList = NODE_COLORS.map((c,i) => `${i}. ${c.name}`).join('\n');
  const idx = prompt('选择节点颜色:\n' + colorList + '\n输入数字:', msg.color ? NODE_COLORS.findIndex(c => c.value === msg.color).toString() : '0');
  if (idx !== null) {
    const ci = parseInt(idx) || 0;
    if (ci >= 0 && ci < NODE_COLORS.length) {
      msg.color = NODE_COLORS[ci].value;
      save();
      openBranchDrawer();
      renderMessages();
    }
  }
};

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
    systemPromptInput.value = conv?.systemPrompt || '';
    userIdentityInput.value = conv?.userIdentity || '';
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
  settings.apiKey = apiKeyInput.value.trim();
  // Display settings
  const fsSelect = document.getElementById('font-size-select');
  const lsSelect = document.getElementById('line-spacing-select');
  if (fsSelect) settings.fontSize = fsSelect.value;
  if (lsSelect) settings.lineSpacing = lsSelect.value;
  applyDisplaySettings();
  saveSettings();

  // Per-conversation only: save prompts directly from input fields
  const conv = currentConv();
  if (conv) {
    conv.thinkingEnabled = thinkingToggle.checked;
    conv.systemPrompt = systemPromptInput.value.trim();
    conv.userIdentity = userIdentityInput.value.trim();
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
  if (window.innerWidth <= 768 && !sidebar.classList.contains('hidden')) {
    if (!sidebar.contains(e.target) && e.target !== sidebarToggle && !sidebarToggle.contains(e.target)) {
      sidebar.classList.add('hidden');
    }
  }
});

// ===== Import / Export =====
function exportConversation() {
  const conv = currentConv();
  if (!conv) return;
  const data = { version: 2, exportedAt: new Date().toISOString(), conversation: conv };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-lite-${conv.title || 'conversation'}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importConversation(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      let conv;
      
      // Format 1: chat-lite export
      if (data.version && data.conversation) {
        conv = data.conversation;
        if (!conv.id || !conv.messageMap) throw new Error('chat-lite format corrupted');
      }
      // Format 2: DZMM export
      else if (data.chatId && data.chat && data.messages) {
        conv = convertDZMM(data);
      }
      // Format 3: plain chat-lite conversation (no wrapper)
      else if (data.id && data.messageMap) {
        conv = data;
      }
      // Format 4: old v1 linear array
      else if (data.messages && Array.isArray(data.messages)) {
        conv = { messages: data.messages };
        migrateV1toV2(conv);
      }
      else {
        alert('不支持的格式，请导入 chat-lite 导出的 JSON 或 DZMM 导出的 JSON');
        return;
      }
      
      conv.id = uid();
      state.conversations.push(conv);
      state.currentId = conv.id;
      save();
      renderSidebar();
      renderMessages();
      if (conv.model) modelSelect.value = conv.model;
    } catch (err) {
      alert('文件解析失败: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// Convert DZMM (dzmm.ai) export format to chat-lite tree
function convertDZMM(data) {
  const chat = data.chat || {};
  const chunks = chat.chunks || [];
  const messages = data.messages || [];
  
  // Build message lookup by chunk_id
  const chunkMsgs = {};
  for (const entry of messages) {
    chunkMsgs[entry.chunk_id] = entry.messages || [];
  }
  
  // Build chunk map  
  const chunkMap = {};
  for (const c of chunks) {
    chunkMap[c.id] = c;
  }
  
  // Find root chunks
  const roots = chunks.filter(c => !c.parent);
  const rootId = uid();
  const rootMsg = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
  const messageMap = { [rootId]: rootMsg };
  
  // Helper to create a message node
  function createMsgNode(role, content, parentId) {
    const text = String(content || '');
    const node = {
      id: uid(), role, content: text,
      parentId, children: [],
      title: (role === 'user' ? (text.substring(0, 30) + (text.length > 30 ? '...' : '')) : '回复').replace(/\n/g, ' '),
      wordCount: countWords(text),
      versions: [{ content: text, timestamp: Date.now(), reason: 'import' }],
      activeVersion: 0, files: [], createdAt: Date.now()
    };
    messageMap[node.id] = node;
    messageMap[parentId].children.push(node.id);
    return node.id;
  }
  
  // Cache: chunkId → [nodeIds] so we can trace active path
  const chunkNodeIds = {};
  // Cache: chunkId → lastNodeId for child chunk attachment
  const chunkLastNode = {};
  
  // Walk the tree: create individual nodes per message, NOT merged
  function walk(chunkId, parentId) {
    const chunk = chunkMap[chunkId];
    if (!chunk) return parentId;
    
    // If already walked, just re-attach first node
    if (chunkLastNode[chunkId] !== undefined) {
      const lastId = chunkLastNode[chunkId];
      const nids = chunkNodeIds[chunkId] || [];
      if (nids.length > 0 && messageMap[nids[0]] && !messageMap[parentId].children.includes(nids[0])) {
        messageMap[nids[0]].parentId = parentId;
        messageMap[parentId].children.push(nids[0]);
      }
      return lastId;
    }
    
    const msgs = chunkMsgs[chunkId] || [];
    let lastId = parentId;
    
    // Create individual nodes for each message (NO merging)
    const nodeIds = [];
    for (const m of msgs) {
      const ct = (typeof m.content === 'string' ? m.content : String(m.content || ''));
      if (!ct) continue;
      lastId = createMsgNode(m.role || 'user', ct, lastId);
      nodeIds.push(lastId);
    }
    
    chunkNodeIds[chunkId] = nodeIds;
    chunkLastNode[chunkId] = lastId;
    
    // Walk children — they attach to lastId
    const children = (chunk.children || []).filter(c => chunkMap[c]);
    for (const childId of children) {
      walk(childId, lastId);
    }
    
    return lastId;
  }
  
  // Walk all chunks from each root
  for (const r of roots) {
    walk(r.id, rootId);
  }
  
  // Build activePath: follow chunk.active chain, use chunkNodeIds cache directly
  const convActivePath = [rootId];
  function followActive(chunkId) {
    const chunk = chunkMap[chunkId];
    if (!chunk) return;
    
    // Push all nodes from this chunk
    const nodeIds = chunkNodeIds[chunkId] || [];
    for (const nid of nodeIds) {
      convActivePath.push(nid);
    }
    
    // Find active child chunk and recurse
    const children = (chunk.children || []).filter(c => chunkMap[c]);
    const activeChild = children.find(c => chunkMap[c]?.active);
    if (activeChild) {
      followActive(activeChild);
    }
  }
  
  for (const r of roots) {
    if (chunkMap[r]?.active) {
      followActive(r.id);
      break;
    }
  }
  
  // If activePath failed, fallback to first-child chain
  if (convActivePath.length <= 1) {
    let cur = rootId;
    while (true) {
      const node = messageMap[cur];
      if (!node || !node.children || node.children.length === 0) break;
      cur = node.children[0];
      convActivePath.push(cur);
    }
  }

function getBranchPathFromMap(map, rootId, leafId) {
  const path = [];
  let cur = leafId;
  while (cur && cur !== rootId) {
    path.unshift(cur);
    const node = map[cur];
    if (!node || !node.parentId) break;
    cur = node.parentId;
  }
  path.unshift(rootId);
  return path;
}

  return {
    id: uid(),
    title: chat.title || '导入的对话',
    model: 'deepseek-v4-flash',
    thinkingEnabled: true,
    systemPrompt: '',
    userIdentity: '',
    rootId,
    activePath: convActivePath,
    messageMap,
    createdAt: Date.now()
  };
}

// ===== Debug: expose state for CDP inspection =====
window.__chatState = state;
window.__debugConv = function(id) {
  const conv = id ? state.conversations.find(c => c.id === id) : currentConv();
  if (!conv) return null;
  return {
    id: conv.id,
    title: conv.title,
    model: conv.model,
    rootId: conv.rootId,
    activePath: conv.activePath,
    thinkingEnabled: conv.thinkingEnabled,
    messageCount: Object.keys(conv.messageMap || {}).length,
    tree: buildTreeDebug(conv),
    importSource: conv._importSource || null
  };
};
window.__debugList = function() {
  return state.conversations.map(c => ({
    id: c.id, title: c.title, msgCount: Object.keys(c.messageMap || {}).length,
    rootId: c.rootId, pathLen: (c.activePath||[]).length
  }));
};
window.__debugDump = function() {
  const conv = currentConv();
  if (!conv) return null;
  return JSON.parse(JSON.stringify(conv));
};

function buildTreeDebug(conv) {
  const visited = new Set();
  function walk(id, depth) {
    if (!id || visited.has(id)) return null;
    visited.add(id);
    const msg = conv.messageMap?.[id];
    if (!msg) return null;
    return {
      id: id.slice(0,8),
      role: msg.role,
      title: msg.title,
      wordCount: msg.wordCount || 0,
      content: (msg.content||'').substring(0, 60),
      children: (msg.children||[]).map(cid => walk(cid, depth+1)).filter(Boolean),
      inPath: (conv.activePath||[]).includes(id)
    };
  }
  return walk(conv.rootId, 0);
}

// ===== Start =====
document.addEventListener('DOMContentLoaded', init);
