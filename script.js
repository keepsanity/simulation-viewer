/* ============================================================
   시뮬레이션 뷰어 — 시뮬레이션 매니저 백업 JSON 리더
   ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

const S = {
    meta: null,        // 백업 메타(payload) 또는 null
    gs: {},            // globalSimulations 맵
    rooms: [],         // [{ key, name, sims:[...] }] 최신순
    index: new Map(),  // simId -> { sim, room }
    roomKey: '__all__',
    simId: null,
    respIdx: 0,
    query: '',
};

const ALL = '__all__';

/* ---------------- 유틸 ---------------- */
function escapeHtml(t) {
    return String(t ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function simTitle(sim) {
    if (sim?.customTitle && sim.customTitle.trim()) return sim.customTitle.trim();
    if (sim?.promptName && sim.promptName.trim()) return sim.promptName.trim();
    const pt = (sim?.promptText || '').trim();
    if (!pt) return '(제목 없음)';
    return pt.length > 80 ? pt.slice(0, 80) + '…' : pt;
}

function fmtDate(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return '';
    try {
        return new Date(ts).toLocaleString('ko-KR', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch { return ''; }
}

// 응답 파트(이어쓰기 포함) 배열
function responseParts(sim, idx) {
    const base = sim?.responses?.[idx] ?? '';
    const conts = (sim?.continuations && sim.continuations[String(idx)]) || [];
    return [base, ...(Array.isArray(conts) ? conts : [])];
}

// 검색용 평문
function searchText(sim) {
    const parts = [simTitle(sim), sim.promptText || ''];
    (sim.responses || []).forEach((_, i) => parts.push(...responseParts(sim, i)));
    return parts.join('\n').toLowerCase();
}

const POSITION_LABELS = {
    last_message: '마지막 메시지',
    depth_1: '깊이 1',
    depth_0: '깊이 0',
    bottom: '맨 밑',
};

/* ---------------- 마크다운(라이트) ---------------- */
function mdToHtml(src) {
    let html = escapeHtml(src);
    const stash = [];
    const keep = (s) => { stash.push(s); return `${stash.length - 1}`; };

    // 코드 펜스 → 보관
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
        keep(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`));
    // 인라인 코드 → 보관
    html = html.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${c}</code>`));

    // 블록 요소
    html = html
        .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/^\s*([-*_]){3,}\s*$/gm, '<hr>');

    // 인용구 (연속된 > 줄)
    html = html.replace(/(?:^&gt;\s?.*$\n?)+/gm, (m) => {
        const inner = m.trim().split('\n').map(l => l.replace(/^&gt;\s?/, '')).join('<br>');
        return keep(`<blockquote>${inner}</blockquote>`);
    });

    // 인라인 강조
    html = html
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>');

    // 문단 분리
    const blocks = html.split(/\n{2,}/).map((b) => {
        const t = b.trim();
        if (!t) return '';
        if (/^<(h[1-4]|pre|blockquote|hr|)/.test(t) || /^\d+$/.test(t)) {
            return t.replace(/\n/g, '<br>');
        }
        return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    });
    html = blocks.join('\n');

    // 보관 복원
    html = html.replace(/(\d+)/g, (_, i) => stash[+i] ?? '');
    return html;
}

/* ---------------- 데이터 로드 ---------------- */
function normalize(obj) {
    if (obj && typeof obj === 'object') {
        if (obj.globalSimulations && typeof obj.globalSimulations === 'object') {
            return { gs: obj.globalSimulations, meta: obj };
        }
        const vals = Object.values(obj);
        if (vals.length && vals.every(v => v && Array.isArray(v.simulations))) {
            return { gs: obj, meta: null };
        }
    }
    throw new Error('인식할 수 없는 형식입니다. 시뮬레이션 매니저 백업 JSON인지 확인하세요.');
}

function buildRooms(gs) {
    const latest = (sims) => sims.reduce((m, s) => Math.max(m, s?.createdAt || 0), 0);
    const byNewest = (a, b) => (b?.createdAt || 0) - (a?.createdAt || 0);

    const rooms = Object.entries(gs).map(([key, data]) => ({
        key,
        name: (data && data.chatName) || key,
        sims: ((data && data.simulations) || []).slice().sort(byNewest),
    })).filter(r => r.sims.length > 0);

    rooms.sort((a, b) => latest(b.sims) - latest(a.sims));

    const index = new Map();
    for (const room of rooms) {
        for (const sim of room.sims) {
            if (sim && sim.id) index.set(sim.id, { sim, room });
        }
    }
    return { rooms, index };
}

function loadData(obj) {
    const { gs, meta } = normalize(obj);
    const { rooms, index } = buildRooms(gs);
    if (rooms.length === 0) throw new Error('백업에 시뮬레이션이 없습니다.');

    S.meta = meta;
    S.gs = gs;
    S.rooms = rooms;
    S.index = index;
    S.roomKey = ALL;
    S.simId = null;
    S.respIdx = 0;
    S.query = '';

    $('landing').hidden = true;
    $('topbar').hidden = false;
    $('layout').hidden = false;
    $('search').value = '';

    renderStats();
    renderSidebar();
    renderMain();
}

function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            loadData(JSON.parse(reader.result));
        } catch (e) {
            showLandingError(e.message || '파일을 읽을 수 없습니다.');
        }
    };
    reader.onerror = () => showLandingError('파일을 읽는 중 오류가 발생했습니다.');
    reader.readAsText(file);
}

/* ---------------- 렌더: 통계/사이드바 ---------------- */
function totalSimCount() {
    return S.rooms.reduce((n, r) => n + r.sims.length, 0);
}

function renderStats() {
    const parts = [`채팅방 <b>${S.rooms.length}</b>`, `시뮬 <b>${totalSimCount()}</b>`];
    if (S.meta && S.meta.exportedAt) {
        const d = new Date(S.meta.exportedAt);
        if (!isNaN(d)) parts.push(`내보냄 ${d.toLocaleDateString('ko-KR')}`);
    }
    $('stats').innerHTML = parts.join(' · ');
}

function renderSidebar() {
    const nav = $('roomList');
    const total = totalSimCount();
    let html = `
        <button class="room room-all ${S.roomKey === ALL ? 'active' : ''}" data-key="${ALL}">
            <span class="room-name">전체 시뮬레이션</span>
            <span class="room-count">${total}</span>
        </button>`;
    for (const room of S.rooms) {
        html += `
        <button class="room ${S.roomKey === room.key ? 'active' : ''}" data-key="${escapeHtml(room.key)}">
            <span class="room-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span>
            <span class="room-count">${room.sims.length}</span>
        </button>`;
    }
    nav.innerHTML = html;

    nav.querySelectorAll('.room').forEach(el => {
        el.addEventListener('click', () => {
            S.roomKey = el.dataset.key;
            S.simId = null;
            renderSidebar();
            renderMain();
        });
    });
}

/* ---------------- 렌더: 목록/상세 ---------------- */
function visibleSims() {
    let list;
    if (S.roomKey === ALL) {
        list = [];
        for (const room of S.rooms) for (const sim of room.sims) list.push({ sim, room });
        list.sort((a, b) => (b.sim.createdAt || 0) - (a.sim.createdAt || 0));
    } else {
        const room = S.rooms.find(r => r.key === S.roomKey);
        list = room ? room.sims.map(sim => ({ sim, room })) : [];
    }
    const q = S.query.trim().toLowerCase();
    if (q) list = list.filter(({ sim }) => searchText(sim).includes(q));
    return list;
}

function renderMain() {
    if (S.simId && S.index.has(S.simId)) renderReader();
    else renderList();
}

function renderList() {
    const content = $('content');
    const list = visibleSims();
    const roomName = S.roomKey === ALL ? '전체 시뮬레이션' : (S.rooms.find(r => r.key === S.roomKey)?.name || '');

    let html = `
        <div class="list-head">
            <h2 class="list-title">${escapeHtml(roomName)}</h2>
            <span class="list-meta">${list.length}개${S.query ? ` · "${escapeHtml(S.query)}" 검색` : ''}</span>
        </div>`;

    if (list.length === 0) {
        html += `<div class="empty"><div class="empty-ico">🔍</div>${S.query ? '검색 결과가 없습니다.' : '시뮬레이션이 없습니다.'}</div>`;
        content.innerHTML = html;
        return;
    }

    html += `<div class="cards">`;
    for (const { sim, room } of list) {
        const respCount = (sim.responses || []).length;
        const snippet = (sim.promptText || '').trim();
        html += `
        <article class="card" data-id="${escapeHtml(sim.id)}">
            <div class="card-top">
                <div class="card-title">${escapeHtml(simTitle(sim))}</div>
                ${S.roomKey === ALL ? `<span class="card-room" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span>` : ''}
            </div>
            ${snippet ? `<div class="card-snippet">${escapeHtml(snippet)}</div>` : ''}
            <div class="card-foot">
                <span class="badge">💬 응답 ${respCount}</span>
                ${sim.createdAt ? `<span>${escapeHtml(fmtDate(sim.createdAt))}</span>` : ''}
            </div>
        </article>`;
    }
    html += `</div>`;
    content.innerHTML = html;

    content.querySelectorAll('.card').forEach(el => {
        el.addEventListener('click', () => openSim(el.dataset.id));
    });
}

function openSim(id) {
    const entry = S.index.get(id);
    if (!entry) return;
    S.simId = id;
    const ci = entry.sim.currentIndex;
    const len = (entry.sim.responses || []).length;
    S.respIdx = (typeof ci === 'number' && ci >= 0 && ci < len) ? ci : 0;
    renderMain();
    $('content').scrollIntoView({ block: 'start' });
}

function renderReader() {
    const content = $('content');
    const { sim, room } = S.index.get(S.simId);
    const responses = sim.responses || [];
    const total = responses.length;
    S.respIdx = Math.max(0, Math.min(S.respIdx, Math.max(0, total - 1)));

    const chips = [];
    chips.push(`<span class="chip">📁 <b>${escapeHtml(room.name)}</b></span>`);
    if (sim.createdAt) chips.push(`<span class="chip">${escapeHtml(fmtDate(sim.createdAt))}</span>`);
    if (sim.presetName) chips.push(`<span class="chip">프리셋 <b>${escapeHtml(sim.presetName)}</b></span>`);
    if (sim.togglePresetName) chips.push(`<span class="chip">토글 <b>${escapeHtml(sim.togglePresetName)}</b></span>`);
    if (sim.injectPosition && POSITION_LABELS[sim.injectPosition]) chips.push(`<span class="chip">위치 <b>${POSITION_LABELS[sim.injectPosition]}</b></span>`);
    if (sim.swapCharUser) chips.push(`<span class="chip chip-accent">char↔user</span>`);
    if (sim.swapPronouns) chips.push(`<span class="chip chip-accent">대명사 교체</span>`);

    let answerHtml;
    if (total === 0) {
        answerHtml = `<div class="empty"><div class="empty-ico">💭</div>저장된 응답이 없습니다.</div>`;
    } else {
        const parts = responseParts(sim, S.respIdx);
        answerHtml = `<div class="answer">` + parts.map((p, i) =>
            (i > 0 ? `<div class="part-divider">이어쓰기 파트 ${i + 1}</div>` : '') + mdToHtml(p || '')
        ).join('') + `</div>`;
    }

    const swipe = total > 1 ? `
        <div class="resp-nav">
            <button class="swipe-btn" id="prevResp" ${S.respIdx <= 0 ? 'disabled' : ''} title="이전 응답">‹</button>
            <span class="swipe-pos">${S.respIdx + 1} / ${total}</span>
            <button class="swipe-btn" id="nextResp" ${S.respIdx >= total - 1 ? 'disabled' : ''} title="다음 응답">›</button>
        </div>` : '';

    content.innerHTML = `
        <div class="reader">
            <button class="back" id="backBtn">‹ 목록으로</button>
            <h1 class="reader-title">${escapeHtml(simTitle(sim))}</h1>
            <div class="chips">${chips.join('')}</div>

            <div class="section-label">요청</div>
            <div class="request">${escapeHtml(sim.promptText || '(내용 없음)')}</div>

            <div class="resp-bar">
                <div class="section-label" style="margin:0;">응답</div>
                ${swipe}
            </div>
            ${answerHtml}
        </div>`;

    $('backBtn').addEventListener('click', () => { S.simId = null; renderMain(); });
    $('prevResp')?.addEventListener('click', () => { if (S.respIdx > 0) { S.respIdx--; renderReader(); } });
    $('nextResp')?.addEventListener('click', () => { if (S.respIdx < total - 1) { S.respIdx++; renderReader(); } });
}

/* ---------------- 랜딩/에러/토스트 ---------------- */
function showLandingError(msg) {
    const el = $('landingErr');
    el.textContent = '⚠️ ' + msg;
    el.hidden = false;
}

let toastTimer = null;
function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function showLanding() {
    $('topbar').hidden = true;
    $('layout').hidden = true;
    $('landing').hidden = false;
    $('landingErr').hidden = true;
    $('file').value = '';
}

/* ---------------- 테마 ---------------- */
function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeBtn').textContent = t === 'dark' ? '🌙' : '☀️';
    try { localStorage.setItem('simviewer-theme', t); } catch {}
}

/* ---------------- 초기화 ---------------- */
function init() {
    try {
        const saved = localStorage.getItem('simviewer-theme');
        if (saved === 'light' || saved === 'dark') applyTheme(saved);
    } catch {}

    // 파일 입력
    const fileInput = $('file');
    const drop = $('drop');
    fileInput.addEventListener('change', (e) => readFile(e.target.files[0]));

    ['dragenter', 'dragover'].forEach(ev =>
        drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev =>
        drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => {
        const f = e.dataTransfer?.files?.[0];
        if (f) readFile(f);
    });

    // 상단 바
    $('search').addEventListener('input', (e) => {
        S.query = e.target.value;
        if (S.simId) S.simId = null; // 검색 시 목록으로
        renderMain();
    });
    $('themeBtn').addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
    });
    $('reopenBtn').addEventListener('click', showLanding);

    // 키보드: 좌우로 응답 스와이프
    document.addEventListener('keydown', (e) => {
        if (!S.simId) return;
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (e.key === 'ArrowLeft') $('prevResp')?.click();
        else if (e.key === 'ArrowRight') $('nextResp')?.click();
        else if (e.key === 'Escape') { S.simId = null; renderMain(); }
    });
}

document.addEventListener('DOMContentLoaded', init);
