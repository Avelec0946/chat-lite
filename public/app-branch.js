// ===== chat-lite Branch Module (lazy loaded) =====
// Contains: branch drawer, SVG tree, zoom/pinch/drag, node interactions

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
  branchZoom = Math.max(0.3, Math.min(branchZoom + delta, 50));
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
  const newZoom = Math.max(0.3, Math.min(pinchState.startZoom * scale, 50));
  
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


// Bind zoom events after load
(function() {
  const zi = document.getElementById('btn-zoom-in');
  const zo = document.getElementById('btn-zoom-out');
  const zl = document.getElementById('zoom-input');
  if (zi) zi.addEventListener('click', function() { branchZoom = branchZoom + 0.08; applyBranchZoom(); updateZoomInput(); });
  if (zo) zo.addEventListener('click', function() { branchZoom = Math.max(branchZoom - 0.08, 0.3); applyBranchZoom(); updateZoomInput(); });
  if (zl) {
    zl.addEventListener('change', function() {
      const v = parseInt(zl.value) / 100;
      if (v > 0) { branchZoom = v; applyBranchZoom(); }
      updateZoomInput();
    });
    zl.addEventListener('keydown', function(e) { if (e.key === 'Enter') zl.blur(); });
  }
  // Bind branch button center-on-open
  const bb = document.getElementById('btn-branch');
  if (bb) {
    bb.addEventListener('click', function() { setTimeout(applyBranchCenter, 200); });
  }
})();
