// ═══════════════════════════════════════════════════════════
// 불러불러 — Main Page (Room List)
// ═══════════════════════════════════════════════════════════

// Auto-set admin token via URL: ?admin=bb_owner_2024
(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('admin') === 'bb_owner_2024') {
        localStorage.setItem('bb_admin', 'bb_owner_2024');
        // Clean URL
        window.history.replaceState({}, '', window.location.pathname);
        alert('✅ 관리자 인증 완료!');
    }
})();

const socket = io();

// DOM
const roomsGrid = document.getElementById('roomsGrid');
const roomCount = document.getElementById('roomCount');
const createRoomBtn = document.getElementById('createRoomBtn');
const createRoomModal = document.getElementById('createRoomModal');
const roomNameInput = document.getElementById('roomNameInput');
const cancelCreateBtn = document.getElementById('cancelCreateBtn');
const confirmCreateBtn = document.getElementById('confirmCreateBtn');
const toastContainer = document.getElementById('toastContainer');
const roomSearchInput = document.getElementById('roomSearchInput');

let allRooms = []; // Cache for filtering

// ── Toast ─────────────────────────────────────────────────
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ── Room List Rendering ───────────────────────────────────
function renderRooms(rooms) {
    allRooms = rooms;
    const query = (roomSearchInput?.value || '').toLowerCase();
    const sorted = [...rooms].sort((a, b) => b.userCount - a.userCount);
    const filtered = query ? sorted.filter(r => r.name.toLowerCase().includes(query)) : sorted;
    if (roomCount) roomCount.textContent = rooms.length;

    if (filtered.length === 0) {
        roomsGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; padding: 4rem 1rem;">
        <div class="empty-state__icon">🎤</div>
        <div>아직 방이 없습니다. 새 방을 만들어보세요!</div>
      </div>
    `;
        return;
    }

    roomsGrid.innerHTML = filtered.map(room => `
    <div class="glass-card room-card" data-room-id="${room.id}" onclick="enterRoom('${room.id}', ${room.hasPassword})">
      <div class="room-card__name">${room.hasPassword ? '🔒 ' : ''}${escapeHtml(room.name)}</div>
      <div class="room-card__info">
        <span class="room-card__users">
          <span class="dot"></span>
          ${room.userCount}/${room.maxUsers}명
        </span>
        ${room.currentMR
            ? `<span class="room-card__mr">🎵 ${escapeHtml(room.currentMR.title)}</span>`
            : '<span class="room-card__mr" style="color: var(--text-muted);">대기중</span>'
        }
        <button class="btn btn-primary btn-sm room-card__enter">입장</button>
      </div>
    </div>
  `).join('');
}

// ── Enter Room ────────────────────────────────────────────
function enterRoom(roomId, hasPassword) {
    if (hasPassword) {
        const pw = prompt('비밀번호를 입력하세요:');
        if (pw === null) return; // cancelled
        window.location.href = `/room.html?id=${roomId}&pw=${encodeURIComponent(pw)}`;
    } else {
        window.location.href = `/room.html?id=${roomId}`;
    }
}

// ── Create Room Modal ─────────────────────────────────────
let selectedMicCount = 2;

createRoomBtn.addEventListener('click', () => {
    createRoomModal.classList.add('active');
    roomNameInput.value = '';
    document.getElementById('roomPasswordInput').value = '';
    document.getElementById('maxUsersSlider').value = 20;
    document.getElementById('maxUsersLabel').textContent = '20명';
    selectedMicCount = 2;
    updateMicCountUI();
    roomNameInput.focus();
});

// Mic count selector
const micCountSelector = document.getElementById('micCountSelector');
micCountSelector.addEventListener('click', (e) => {
    const btn = e.target.closest('.mic-count-opt');
    if (!btn) return;
    selectedMicCount = parseInt(btn.dataset.count);
    updateMicCountUI();
});

function updateMicCountUI() {
    document.querySelectorAll('.mic-count-opt').forEach(btn => {
        if (parseInt(btn.dataset.count) === selectedMicCount) {
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-primary');
        } else {
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-secondary');
        }
    });
}

cancelCreateBtn.addEventListener('click', () => {
    createRoomModal.classList.remove('active');
});

createRoomModal.addEventListener('click', (e) => {
    if (e.target === createRoomModal) {
        createRoomModal.classList.remove('active');
    }
});

confirmCreateBtn.addEventListener('click', createRoom);
roomNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createRoom();
});

function createRoom() {
    const name = roomNameInput.value.trim();
    if (!name) {
        showToast('방 이름을 입력해주세요!');
        return;
    }

    const password = document.getElementById('roomPasswordInput').value.trim() || null;
    const maxUsers = parseInt(document.getElementById('maxUsersSlider').value) || 20;

    socket.emit('create-room', { name, maxMics: selectedMicCount, password, maxUsers }, (room) => {
        createRoomModal.classList.remove('active');
        showToast(`"${room.name}" 방이 생성되었습니다!`);
        enterRoom(room.id, false);
    });
}

// ── Socket Events ─────────────────────────────────────────
socket.on('room-list', (rooms) => {
    renderRooms(rooms);
});

// ── Utilities ─────────────────────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Max Users slider
const maxUsersSlider = document.getElementById('maxUsersSlider');
const maxUsersLabel = document.getElementById('maxUsersLabel');
maxUsersSlider.addEventListener('input', () => {
    maxUsersLabel.textContent = maxUsersSlider.value + '명';
});

// Room search filter
if (roomSearchInput) {
    roomSearchInput.addEventListener('input', () => {
        renderRooms(allRooms);
    });
}
