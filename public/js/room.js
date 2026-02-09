// ═══════════════════════════════════════════════════════════
// 불러불러 — Room Page
// YouTube Player, Mic Slots, WebRTC, Favorites, Recent
// ═══════════════════════════════════════════════════════════

(() => {
    // ── Config ──────────────────────────────────────────────
    const MAX_RECENT = 50;
    const STORAGE_FAVORITES = 'karaoke_favorites';
    const STORAGE_RECENT = 'karaoke_recent';

    // ── URL Params ──────────────────────────────────────────
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('id');
    const roomPassword = params.get('pw') || null;
    if (!roomId) { window.location.href = '/'; return; }

    // ── Socket ──────────────────────────────────────────────
    const socket = io();

    // ── State ───────────────────────────────────────────────
    let mySocketId = null;
    let myNickname = '';
    let isMicOn = false;
    let isMicTestOn = false;
    let isShyMode = false;
    let localStream = null;
    let processedStream = null;
    let micTestAudio = null;
    let shyOscillator = null;
    let shyModGain = null;
    let shyDelay1 = null;
    let shyDelay2 = null;
    let shyLFO1 = null;
    let shyLFO2 = null;
    let shyLFOGain1 = null;
    let shyLFOGain2 = null;
    let shyMix1 = null;
    let shyMix2 = null;
    let shyFilter = null;
    let peerConnections = {};
    let ytPlayer = null;
    let ytReady = false;

    // Mic slots state
    let myMicSlot = -1;
    let micSlotsData = [];
    let roomMaxMics = 2;
    let roomMaxUsers = 20;
    let roomHostId = null;
    let syncInterval = null;
    let allUsersData = [];      // Cached user list for re-rendering
    let remoteDelayNodes = {};  // socketId -> { delay, ctx } for voice sync

    // Audio processing nodes
    let audioCtx = null;
    let micSource = null;
    let gainNode = null;
    let dryGain = null;
    let wetGain = null;
    let convolver = null;
    let streamDestination = null;

    // ── DOM ─────────────────────────────────────────────────
    const roomNameEl = document.getElementById('roomName');
    const roomNameDisplay = document.getElementById('roomNameDisplay');
    const userCountBadge = document.getElementById('userCountBadge');
    const userCountDisplay = document.getElementById('userCountDisplay');
    const userCountSidebar = document.getElementById('userCountSidebar');
    const userList = document.getElementById('userList');
    const playerIdle = document.getElementById('playerIdle');

    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    const searchResults = document.getElementById('searchResults');
    const favoritesList = document.getElementById('favoritesList');
    const recentList = document.getElementById('recentList');
    const searchLockOverlay = document.getElementById('searchLockOverlay');

    const micSlotsEl = document.getElementById('micSlots');
    const audioVisualizer = document.getElementById('audioVisualizer');
    const micTestBtn = document.getElementById('micTestBtn');
    const shyModeBtn = document.getElementById('shyModeBtn');
    const micExtraBtns = document.getElementById('micExtraBtns');

    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');
    const reverbSlider = document.getElementById('reverbSlider');
    const reverbValue = document.getElementById('reverbValue');

    const toastContainer = document.getElementById('toastContainer');

    // ── Toast ───────────────────────────────────────────────
    function showToast(msg) {
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        toastContainer.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }

    // ═══════════════════════════════════════════════════════
    // 1. ROOM JOIN
    // ═══════════════════════════════════════════════════════
    socket.on('connect', () => {
        mySocketId = socket.id;
        socket.emit('join-room', { roomId, password: roomPassword, adminToken: localStorage.getItem('bb_admin') }, (res) => {
            if (res.error) {
                if (res.error === 'password-required') {
                    const pw = prompt('비밀번호를 입력하세요:');
                    if (pw) {
                        window.location.href = `/room.html?id=${roomId}&pw=${encodeURIComponent(pw)}`;
                    } else {
                        window.location.href = '/';
                    }
                    return;
                }
                showToast(res.error);
                setTimeout(() => window.location.href = '/', 1500);
                return;
            }
            myNickname = res.nickname;
            roomNameEl.textContent = res.roomName;
            if (roomNameDisplay) roomNameDisplay.textContent = res.roomName;
            document.title = `🎤 ${res.roomName} — 불러불러`;
            renderUsers(res.users);

            roomMaxMics = res.maxMics || 2;
            roomMaxUsers = res.maxUsers || 20;
            roomHostId = res.hostId;
            const userMaxBadge = document.getElementById('userMaxBadge');
            if (userMaxBadge) userMaxBadge.textContent = roomMaxUsers;
            micSlotsData = res.mics || [];
            renderMicSlots();
            updateMRPermission();

            if (res.currentMR) {
                playMR(res.currentMR.videoId, res.currentMR.title, res.currentMR.thumbnail, false);
            }
        });
    });

    // User events
    socket.on('user-list', (users) => renderUsers(users));
    socket.on('user-joined', (u) => {
        showToast(`${u.nickname} 님이 입장했습니다`);
        // If I have mic on, create WebRTC connection to the new user
        if (isMicOn && u.socketId !== mySocketId) {
            createPeerConnection(u.socketId, true);
        }
    });
    socket.on('user-left', (u) => showToast(`${u.nickname} 님이 퇴장했습니다`));
    socket.on('user-mic-status', ({ socketId, isOn }) => {
        const el = document.querySelector(`.user-item[data-sid="${socketId}"] .user-item__mic-icon`);
        if (el) el.classList.toggle('on', isOn);
    });

    socket.on('mic-slots-updated', (mics) => {
        micSlotsData = mics;
        myMicSlot = -1;
        mics.forEach(m => {
            if (m.socketId === mySocketId) myMicSlot = m.slot;
        });

        // Sync mic slot info into allUsersData so renderUsers picks it up
        allUsersData.forEach(u => {
            const found = mics.find(m => m.socketId === u.socketId);
            u.micSlot = found ? found.slot : -1;
        });

        renderMicSlots();
        updateMRPermission();
        renderUsers(allUsersData);

        if (myMicSlot === -1 && isMicOn) {
            stopMic();
        }
    });

    // MR events
    socket.on('mr-changed', (mr) => {
        if (mr) playMR(mr.videoId, mr.title, mr.thumbnail, false);
    });
    socket.on('mr-denied', (msg) => showToast('🔒 ' + msg));
    socket.on('host-changed', (hostId) => {
        roomHostId = hostId;
        renderUsers(allUsersData);
    });

    // Kicked by host
    socket.on('kicked', (msg) => {
        showToast('🚫 ' + msg);
        setTimeout(() => window.location.href = '/', 1500);
    });

    // Force mic off by host
    socket.on('force-mic-off', (msg) => {
        showToast('🔇 ' + msg);
        if (isMicOn) stopMic();
        myMicSlot = -1;
    });

    // Room settings updated
    socket.on('room-settings-updated', (data) => {
        roomNameEl.textContent = data.roomName;
        document.title = `🎤 ${data.roomName} — 불러불러`;
        roomMaxMics = data.maxMics;
        roomMaxUsers = data.maxUsers;
        const userMaxBadge = document.getElementById('userMaxBadge');
        if (userMaxBadge) userMaxBadge.textContent = roomMaxUsers;
        showToast('⚙️ 방 설정이 변경되었습니다.');
    });

    // Video time sync (from mic 1 user)
    socket.on('sync-mr-time', (data) => {
        if (!ytPlayer || !ytReady) return;
        if (myMicSlot === 0) return; // I AM mic 1, ignore

        try {
            const targetTime = data.currentTime - 1.5; // 1.5초 늦게 재생 (보이스 지연 보정)
            const myTime = ytPlayer.getCurrentTime();
            const diff = Math.abs(myTime - targetTime);

            if (diff > 2) {
                ytPlayer.seekTo(Math.max(0, targetTime), true);
            }

            if (data.isPlaying && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) {
                ytPlayer.playVideo();
            } else if (!data.isPlaying && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
                ytPlayer.pauseVideo();
            }
        } catch (e) { }
    });

    // ── Render Users ──────────────────────────────────────
    function renderUsers(users) {
        allUsersData = users;
        if (userCountBadge) userCountBadge.textContent = users.length;
        if (userCountSidebar) userCountSidebar.textContent = users.length;
        if (userCountDisplay) userCountDisplay.textContent = users.length;
        const userMaxBadge = document.getElementById('userMaxBadge');
        if (userMaxBadge) userMaxBadge.textContent = roomMaxUsers;
        const userMaxDisplay = document.getElementById('userMaxDisplay');
        if (userMaxDisplay) userMaxDisplay.textContent = roomMaxUsers;

        const isHost = (roomHostId === mySocketId);
        const colors = ['#FF2D8A', '#00D4FF', '#A855F7', '#22C55E', '#F59E0B', '#EF4444'];

        userList.innerHTML = users.map((u, i) => {
            const isMe = u.socketId === mySocketId;
            const micLabel = u.micSlot >= 0 ? `<span class="user-item__mic-badge">${u.micSlot + 1}번</span>` : '';
            const hostBadge = u.isHost ? '<span class="user-item__host-badge">👑</span>' : '';

            // Host admin buttons (only shown to host, not on self)
            let adminBtns = '';
            if (isHost && !isMe) {
                adminBtns = `
              <div class="user-item__admin">
                <button class="admin-btn admin-btn--kick" data-sid="${u.socketId}" title="강퇴">🚫</button>
              </div>
            `;
            }

            return `
          <div class="user-item ${isMe ? 'user-item--me' : ''}" data-sid="${u.socketId}">
            <span class="user-item__name">${hostBadge}${u.nickname}${isMe ? ' (나)' : ''}</span>
            ${micLabel}
            ${u.micSlot >= 0 ? `<span class="user-item__mic-icon on" data-sid="${u.socketId}" title="마이크 끄기">🎤</span>` : ''}
            ${adminBtns}
          </div>
        `;
        }).join('');

        // Admin button click handlers
        userList.querySelectorAll('.admin-btn--kick').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('정말 강퇴하시겠습니까?')) {
                    socket.emit('kick-user', btn.dataset.sid);
                }
            });
        });
        // Mic icon click — host can click to force mic off
        if (roomHostId === mySocketId) {
            userList.querySelectorAll('.user-item__mic-icon[data-sid]').forEach(icon => {
                icon.style.cursor = 'pointer';
                icon.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const sid = icon.dataset.sid;
                    if (sid !== mySocketId) {
                        socket.emit('force-release-mic', sid);
                    }
                });
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    // 2. MIC SLOTS
    // ═══════════════════════════════════════════════════════

    function renderMicSlots() {
        const slotLabels = ['1번', '2번', '3번', '4번'];
        let html = '';

        for (let i = 0; i < roomMaxMics; i++) {
            const slotData = micSlotsData[i] || { slot: i, socketId: null, nickname: null };
            const isEmpty = !slotData.socketId;
            const isMine = slotData.socketId === mySocketId;
            const isOccupied = !isEmpty && !isMine;
            const isLocked = isOccupied; // Can't click other people's mic

            let stateClass = 'empty';
            if (isMine) stateClass = 'mine';
            else if (isOccupied) stateClass = 'occupied';
            if (isLocked) stateClass += ' locked';

            const icon = isMine ? '🎤' : (isOccupied ? '🎤' : '🎙️');
            const label = isEmpty ? '비어있음' : slotData.nickname;

            html += `
        <div class="mic-slot ${stateClass}" data-slot="${i}" title="${slotLabels[i]} 마이크">
          ${isLocked ? '<span class="mic-slot__lock-icon">🔒</span>' : ''}
          <span class="mic-slot__number">${slotLabels[i]}</span>
          <span class="mic-slot__icon">${icon}</span>
          <span class="mic-slot__label">${label}</span>
          ${isMine ? `
            <div class="mic-slot__icon-btns" onclick="event.stopPropagation()">
              <button class="mic-icon-btn ${isMicTestOn ? 'active' : ''}" id="micTestBtnSlot" title="마이크 테스트">${isMicTestOn ? '🔊' : '🔇'}</button>
              <button class="mic-icon-btn ${isShyMode ? 'active' : ''}" id="shyModeBtnSlot" title="부끄럼쟁이">${isShyMode ? '😎' : '🫣'}</button>
            </div>
            <div class="voice-volume-slider" onclick="event.stopPropagation()">
              <label>🔊 볼륨</label>
              <input type="range" min="0" max="200" value="${volumeSlider?.value || 100}" id="myVolSlider" />
              <span class="voice-volume-val" id="myVolVal">${volumeSlider?.value || 100}%</span>
            </div>
            <div class="voice-delay-slider" onclick="event.stopPropagation()">
              <label>🎶 리버브</label>
              <input type="range" min="0" max="100" value="${reverbSlider?.value || 0}" id="myRevSlider" />
              <span class="voice-delay-val" id="myRevVal">${reverbSlider?.value || 0}%</span>
            </div>
          ` : ''}
          ${(isOccupied && !isMine) ? `
            <div class="voice-volume-slider" onclick="event.stopPropagation()">
              <label>🔊 볼륨</label>
              <input type="range" min="0" max="200" value="${getVoiceVolume(slotData.socketId)}" data-sid="${slotData.socketId}" />
              <span class="voice-volume-val">${getVoiceVolume(slotData.socketId)}%</span>
            </div>
            <div class="voice-delay-slider" onclick="event.stopPropagation()">
              <label>⏱ 싱크</label>
              <input type="range" min="0" max="1000" value="${getVoiceDelay(slotData.socketId)}" data-sid="${slotData.socketId}" />
              <span class="voice-delay-val">${getVoiceDelay(slotData.socketId)}ms</span>
            </div>
          ` : ''}
        </div>
      `;
        }

        micSlotsEl.innerHTML = html;

        // Click handlers
        micSlotsEl.querySelectorAll('.mic-slot').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.voice-delay-slider') || e.target.closest('.voice-volume-slider') || e.target.closest('.mic-slot__icon-btns')) return;
                onMicSlotClick(parseInt(el.dataset.slot));
            });
        });

        // Inline mic test icon button
        const micTestBtnSlot = document.getElementById('micTestBtnSlot');
        if (micTestBtnSlot) {
            micTestBtnSlot.addEventListener('click', () => {
                document.getElementById('micTestBtn')?.click();
            });
        }

        // Inline shy mode icon button
        const shyModeBtnSlot = document.getElementById('shyModeBtnSlot');
        if (shyModeBtnSlot) {
            shyModeBtnSlot.addEventListener('click', () => {
                document.getElementById('shyModeBtn')?.click();
            });
        }

        // My volume slider (inline in mic slot)
        const myVolSlider = document.getElementById('myVolSlider');
        if (myVolSlider) {
            myVolSlider.addEventListener('input', () => {
                const val = parseInt(myVolSlider.value);
                const label = document.getElementById('myVolVal');
                if (label) label.textContent = val + '%';
                // Sync with hidden volumeSlider
                if (volumeSlider) {
                    volumeSlider.value = val;
                    volumeSlider.dispatchEvent(new Event('input'));
                }
            });
        }

        // My reverb slider (inline in mic slot)
        const myRevSlider = document.getElementById('myRevSlider');
        if (myRevSlider) {
            myRevSlider.addEventListener('input', () => {
                const val = parseInt(myRevSlider.value);
                const label = document.getElementById('myRevVal');
                if (label) label.textContent = val + '%';
                // Sync with hidden reverbSlider
                if (reverbSlider) {
                    reverbSlider.value = val;
                    reverbSlider.dispatchEvent(new Event('input'));
                }
            });
        }

        // Voice delay slider handlers
        micSlotsEl.querySelectorAll('.voice-delay-slider input[data-sid]').forEach(slider => {
            slider.addEventListener('input', () => {
                const sid = slider.dataset.sid;
                const val = parseInt(slider.value);
                const label = slider.parentElement.querySelector('.voice-delay-val');
                if (label) label.textContent = val + 'ms';
                applyVoiceDelay(sid, val);
            });
        });

        // Voice volume slider handlers
        micSlotsEl.querySelectorAll('.voice-volume-slider input[data-sid]').forEach(slider => {
            slider.addEventListener('input', () => {
                const sid = slider.dataset.sid;
                const val = parseInt(slider.value);
                const label = slider.parentElement.querySelector('.voice-volume-val');
                if (label) label.textContent = val + '%';
                applyVoiceVolume(sid, val);
            });
        });

    }
    // ── Voice Delay helpers ──────────────────────────────
    function getVoiceDelay(socketId) {
        return remoteDelayNodes[socketId]?.delay || 0;
    }

    function getVoiceVolume(socketId) {
        return remoteDelayNodes[socketId]?.volume ?? 100;
    }

    function applyVoiceDelay(socketId, ms) {
        remoteDelayNodes[socketId] = { ...(remoteDelayNodes[socketId] || {}), delay: ms };
        if (remoteDelayNodes[socketId]?.delayNode) {
            remoteDelayNodes[socketId].delayNode.delayTime.value = ms / 1000;
        }
    }

    function applyVoiceVolume(socketId, pct) {
        remoteDelayNodes[socketId] = { ...(remoteDelayNodes[socketId] || {}), volume: pct };
        if (remoteDelayNodes[socketId]?.gainNode) {
            remoteDelayNodes[socketId].gainNode.gain.value = pct / 100;
        }
        if (remoteDelayNodes[socketId]?.audio) {
            remoteDelayNodes[socketId].audio.volume = pct / 100;
        }
    }

    function onMicSlotClick(slot) {
        const slotData = micSlotsData[slot];
        if (!slotData) return;

        if (slotData.socketId === mySocketId) {
            // Release my mic
            releaseMic(slot);
        } else if (!slotData.socketId) {
            // Claim empty slot
            if (myMicSlot !== -1) {
                showToast('이미 마이크를 잡고 있습니다. 먼저 놓아주세요.');
                return;
            }
            claimMic(slot);
        } else {
            // Locked (someone else's)
            showToast('다른 사람이 사용 중인 마이크입니다.');
        }
    }

    function claimMic(slot) {
        socket.emit('claim-mic', slot, async (res) => {
            if (res.error) {
                showToast(res.error);
                return;
            }
            myMicSlot = slot;
            showToast(`🎤 ${slot + 1}번 마이크를 잡았습니다!`);
            updateMRPermission();
            await startMic();
        });
    }

    function releaseMic(slot) {
        socket.emit('release-mic', slot);
        myMicSlot = -1;
        stopMic();
        updateMRPermission();
        showToast('마이크를 놓았습니다.');
    }

    // ── Video Permission ───────────────────────────────────
    function updateMRPermission() {
        const canControlMR = (myMicSlot === 0);
        if (canControlMR) {
            searchLockOverlay.classList.remove('active');
            // Start syncing video time to others
            startMRSync();
        } else {
            searchLockOverlay.classList.add('active');
            stopMRSync();
        }
    }

    function startMRSync() {
        stopMRSync();
        syncInterval = setInterval(() => {
            if (!ytPlayer || !ytReady) return;
            try {
                socket.emit('sync-mr-time', {
                    currentTime: ytPlayer.getCurrentTime(),
                    videoId: ytPlayer.getVideoData()?.video_id,
                    isPlaying: ytPlayer.getPlayerState() === YT.PlayerState.PLAYING
                });
            } catch (e) { }
        }, 5000);
    }

    function stopMRSync() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }

    // ═══════════════════════════════════════════════════════
    // 3. YOUTUBE PLAYER
    // ═══════════════════════════════════════════════════════

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);

    let pendingVideoId = null;

    window.onYouTubeIframeAPIReady = () => {
        ytPlayer = new YT.Player('yt-player', {
            height: '100%',
            width: '100%',
            playerVars: {
                autoplay: 0,
                controls: 1,
                rel: 0,
                modestbranding: 1,
                enablejsapi: 1,
                origin: window.location.origin
            },
            events: {
                onReady: () => {
                    ytReady = true;
                    if (pendingVideoId) {
                        loadAndPlay(pendingVideoId);
                        pendingVideoId = null;
                    }
                },
                onStateChange: (e) => {
                    if (e.data === YT.PlayerState.ENDED) {
                        // Could auto-play next
                    }
                }
            }
        });
    };

    function loadAndPlay(videoId) {
        playerIdle.style.display = 'none';
        ytPlayer.loadVideoById(videoId);
        setTimeout(() => {
            try {
                ytPlayer.unMute();
                ytPlayer.setVolume(100);
            } catch (e) { }
        }, 300);
    }

    function playMR(videoId, title, thumbnail, broadcast = true) {
        if (!ytReady) {
            pendingVideoId = videoId;
        } else {
            loadAndPlay(videoId);
        }

        addToRecent({ videoId, title, thumbnail });
        showToast(`🎵 재생: ${title}`);

        if (broadcast) {
            // Only mic 1 can broadcast (server enforces too)
            socket.emit('play-mr', { videoId, title, thumbnail });
        }
    }

    socket.on('mr-changed', (mr) => {
        if (mr) playMR(mr.videoId, mr.title, mr.thumbnail, false);
    });

    // ═══════════════════════════════════════════════════════
    // 4. SEARCH
    // ═══════════════════════════════════════════════════════

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    async function doSearch() {
        // Only mic 1 can search
        if (myMicSlot !== 0) {
            showToast('🔒 1번 마이크를 잡아야 영상을 검색할 수 있습니다.');
            return;
        }

        const query = searchInput.value.trim();
        if (!query) return;

        searchResults.innerHTML = '<div class="spinner"></div>';
        switchTab('search');

        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            const results = await res.json();

            if (results.length === 0) {
                searchResults.innerHTML = `
          <div class="empty-state">
            <div class="empty-state__icon">😅</div>
            <div>검색 결과가 없습니다</div>
          </div>
        `;
                return;
            }

            renderResultList(searchResults, results);
        } catch (err) {
            console.error('Search error:', err);
            searchResults.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">⚠️</div>
          <div>검색 중 오류가 발생했습니다</div>
        </div>
      `;
        }
    }

    // ═══════════════════════════════════════════════════════
    // 5. RESULT RENDERING
    // ═══════════════════════════════════════════════════════

    function renderResultList(container, items) {
        container.innerHTML = items.map(item => `
      <div class="result-item" data-video-id="${item.videoId}">
        <img class="result-item__thumb" src="${item.thumbnail}" alt="" loading="lazy" />
        <div class="result-item__info">
          <div class="result-item__title">${item.title}</div>
          <div class="result-item__channel">${item.channel || ''}${item.duration ? ' · ' + item.duration : ''}</div>
        </div>
        <div class="result-item__actions">
          <button class="result-item__fav ${isFavorite(item.videoId) ? 'active' : ''}" 
                  data-video-id="${item.videoId}" title="즐겨찾기">⭐</button>
        </div>
      </div>
    `).join('');

        // Click to play (only for mic 1)
        container.querySelectorAll('.result-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.result-item__fav')) return;

                if (myMicSlot !== 0) {
                    showToast('🔒 1번 마이크를 잡아야 영상을 재생할 수 있습니다.');
                    return;
                }

                const item = items.find(i => i.videoId === el.dataset.videoId);
                if (item) playMR(item.videoId, item.title, item.thumbnail, true);
            });
        });

        // Fav toggle
        container.querySelectorAll('.result-item__fav').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const vid = btn.dataset.videoId;
                const item = items.find(i => i.videoId === vid);
                if (!item) return;
                toggleFavorite(item);
                btn.classList.toggle('active');
            });
        });
    }

    // ═══════════════════════════════════════════════════════
    // 6. TABS
    // ═══════════════════════════════════════════════════════

    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    function switchTab(tabName) {
        document.querySelectorAll('.tab').forEach(t =>
            t.classList.toggle('active', t.dataset.tab === tabName));
        document.querySelectorAll('[data-tab-content]').forEach(c =>
            c.style.display = c.dataset.tabContent === tabName ? '' : 'none');

        if (tabName === 'favorites') renderFavorites();
        if (tabName === 'recent') renderRecent();
    }

    // ═══════════════════════════════════════════════════════
    // 7. FAVORITES & RECENT
    // ═══════════════════════════════════════════════════════

    function getFavorites() {
        try { return JSON.parse(localStorage.getItem(STORAGE_FAVORITES)) || []; }
        catch { return []; }
    }
    function saveFavorites(favs) { localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(favs)); }
    function isFavorite(videoId) { return getFavorites().some(f => f.videoId === videoId); }

    function toggleFavorite(item) {
        let favs = getFavorites();
        const idx = favs.findIndex(f => f.videoId === item.videoId);
        if (idx !== -1) {
            favs.splice(idx, 1);
            showToast('즐겨찾기에서 제거했습니다.');
        } else {
            favs.unshift({ videoId: item.videoId, title: item.title, channel: item.channel || '', thumbnail: item.thumbnail });
            showToast('⭐ 즐겨찾기에 추가했습니다!');
        }
        saveFavorites(favs);
    }

    function renderFavorites() {
        const favs = getFavorites();
        if (favs.length === 0) {
            favoritesList.innerHTML = '<div class="empty-state"><div class="empty-state__icon">⭐</div><div>즐겨찾기한 영상이 없습니다</div></div>';
            return;
        }
        renderResultList(favoritesList, favs);
    }

    function getRecent() {
        try { return JSON.parse(localStorage.getItem(STORAGE_RECENT)) || []; }
        catch { return []; }
    }
    function saveRecent(list) { localStorage.setItem(STORAGE_RECENT, JSON.stringify(list)); }

    function addToRecent(item) {
        let recent = getRecent();
        recent = recent.filter(r => r.videoId !== item.videoId);
        recent.unshift({ videoId: item.videoId, title: item.title, thumbnail: item.thumbnail });
        if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
        saveRecent(recent);
    }

    function renderRecent() {
        const recent = getRecent();
        if (recent.length === 0) {
            recentList.innerHTML = '<div class="empty-state"><div class="empty-state__icon">🕐</div><div>최근 재생한 영상이 없습니다</div></div>';
            return;
        }
        renderResultList(recentList, recent);
    }

    // ═══════════════════════════════════════════════════════
    // 8. MICROPHONE & AUDIO PROCESSING
    // ═══════════════════════════════════════════════════════

    micTestBtn.addEventListener('click', toggleMicTest);
    shyModeBtn.addEventListener('click', toggleShyMode);

    // ── Mic Test (loopback) ──────────────────────────────
    function toggleMicTest() {
        if (!isMicOn || !localStream) return;

        if (isMicTestOn) {
            if (micTestAudio) {
                micTestAudio.pause();
                micTestAudio.srcObject = null;
                micTestAudio = null;
            }
            isMicTestOn = false;
            micTestBtn.textContent = '🔊 마이크 테스트 OFF';
            micTestBtn.classList.remove('btn-primary');
            micTestBtn.classList.add('btn-secondary');
            showToast('마이크 테스트 OFF');
        } else {
            micTestAudio = new Audio();
            micTestAudio.srcObject = processedStream || localStream;
            micTestAudio.play().catch(() => { });
            isMicTestOn = true;
            micTestBtn.textContent = '🔊 마이크 테스트 ON';
            micTestBtn.classList.remove('btn-secondary');
            micTestBtn.classList.add('btn-primary');
            showToast('🔊 마이크 테스트 ON — 내 목소리가 들립니다');
        }
        renderMicSlots();
    }

    // ── Shy Mode (voice disguise) ────────────────────────
    function toggleShyMode() {
        if (!isMicOn || !audioCtx) return;
        if (isShyMode) {
            stopShyMode();
            showToast('부끄럼쟁이 모드 OFF');
        } else {
            startShyMode();
            showToast('🫣 부끄럼쟁이 모드 ON — 목소리가 변조됩니다!');
        }
    }

    function startShyMode() {
        if (!audioCtx || !shyModGain) return;

        // ── Pitch shift via dual crossfaded delay lines ──
        // Two delay taps with offset triangle wave LFOs create
        // continuous pitch shift (~3-4 semitones up)
        const baseDelay = 0.02; // 20ms base
        const modDepth = 0.012; // modulation depth
        const shiftRate = 4;    // LFO speed in Hz

        shyDelay1 = audioCtx.createDelay(0.2);
        shyDelay1.delayTime.value = baseDelay;
        shyDelay2 = audioCtx.createDelay(0.2);
        shyDelay2.delayTime.value = baseDelay;

        // Triangle LFOs offset by 180° for crossfade
        shyLFO1 = audioCtx.createOscillator();
        shyLFO1.type = 'triangle';
        shyLFO1.frequency.value = shiftRate;
        shyLFOGain1 = audioCtx.createGain();
        shyLFOGain1.gain.value = modDepth;
        shyLFO1.connect(shyLFOGain1);
        shyLFOGain1.connect(shyDelay1.delayTime);

        shyLFO2 = audioCtx.createOscillator();
        shyLFO2.type = 'triangle';
        shyLFO2.frequency.value = shiftRate;
        shyLFOGain2 = audioCtx.createGain();
        shyLFOGain2.gain.value = modDepth;
        shyLFO2.connect(shyLFOGain2);
        shyLFOGain2.connect(shyDelay2.delayTime);

        // Crossfade gains (one fades in while other fades out)
        shyMix1 = audioCtx.createGain();
        shyMix1.gain.value = 0.7;
        shyMix2 = audioCtx.createGain();
        shyMix2.gain.value = 0.7;

        // Formant shift filter — boosts highs to change vocal character
        shyFilter = audioCtx.createBiquadFilter();
        shyFilter.type = 'highshelf';
        shyFilter.frequency.value = 2000;
        shyFilter.gain.value = 6;

        // Re-route: shyModGain → delays → filter → dry/wet
        shyModGain.disconnect();
        shyModGain.connect(shyDelay1);
        shyModGain.connect(shyDelay2);
        shyDelay1.connect(shyMix1);
        shyDelay2.connect(shyMix2);
        shyMix1.connect(shyFilter);
        shyMix2.connect(shyFilter);
        shyFilter.connect(dryGain);
        shyFilter.connect(convolver);

        // Start LFOs with offset
        shyLFO1.start();
        shyLFO2.start(audioCtx.currentTime + (1 / shiftRate / 2)); // 180° offset

        isShyMode = true;
        shyModeBtn.textContent = '🫣 부끄럼쟁이 ON';
        shyModeBtn.classList.remove('btn-secondary');
        shyModeBtn.classList.add('btn-primary');
        renderMicSlots();
    }

    function stopShyMode() {
        // Stop LFOs
        [shyLFO1, shyLFO2].forEach(lfo => {
            if (lfo) { try { lfo.stop(); lfo.disconnect(); } catch (e) { } }
        });
        [shyLFOGain1, shyLFOGain2, shyDelay1, shyDelay2, shyMix1, shyMix2, shyFilter].forEach(n => {
            if (n) { try { n.disconnect(); } catch (e) { } }
        });
        shyLFO1 = shyLFO2 = shyLFOGain1 = shyLFOGain2 = null;
        shyDelay1 = shyDelay2 = shyMix1 = shyMix2 = shyFilter = null;

        // Restore original routing: shyModGain → dryGain & convolver
        if (shyModGain && dryGain && convolver) {
            try { shyModGain.disconnect(); } catch (e) { }
            shyModGain.connect(dryGain);
            shyModGain.connect(convolver);
        }

        isShyMode = false;
        shyModeBtn.textContent = '🫣 부끄럼쟁이 OFF';
        shyModeBtn.classList.remove('btn-primary');
        shyModeBtn.classList.add('btn-secondary');
        renderMicSlots();
    }

    // ── Start/Stop Mic ──────────────────────────────────
    async function startMic() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,   // 에코 제거 OFF — 노래 음질 보존
                    noiseSuppression: false,    // 소음 억제 OFF — 노래 다이나믹스 보존
                    autoGainControl: false,     // 자동 게인 OFF — 볼륨 변화 자연스럽게
                    channelCount: 1,            // 모노 — 대역폭 절약
                    sampleRate: 48000           // 48kHz — 음악 표준
                },
                video: false
            });
            setupAudioProcessing(localStream);

            isMicOn = true;
            audioVisualizer.style.display = 'flex';
            socket.emit('mic-status', true);

            startVisualizer(localStream);

            // Connect to existing users via WebRTC
            const userItems = document.querySelectorAll('.user-item[data-sid]');
            userItems.forEach(el => {
                const targetId = el.dataset.sid;
                if (targetId !== mySocketId) {
                    createPeerConnection(targetId, true);
                }
            });

            showToast('🎤 마이크가 켜졌습니다!');
        } catch (err) {
            console.error('Mic error:', err);
            showToast('마이크 접근이 거부되었습니다.');
        }
    }

    function stopMic() {
        isMicOn = false;
        audioVisualizer.style.display = 'none';
        socket.emit('mic-status', false);

        if (isShyMode) stopShyMode();

        if (isMicTestOn) {
            if (micTestAudio) {
                micTestAudio.pause();
                micTestAudio.srcObject = null;
                micTestAudio = null;
            }
            isMicTestOn = false;
            micTestBtn.textContent = '🔊 마이크 테스트 OFF';
            micTestBtn.classList.remove('btn-primary');
            micTestBtn.classList.add('btn-secondary');
        }

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        processedStream = null;

        if (audioCtx) {
            audioCtx.close().catch(() => { });
            audioCtx = null;
            micSource = null;
            gainNode = null;
            dryGain = null;
            wetGain = null;
            convolver = null;
            streamDestination = null;
            shyModGain = null;
            shyDelay1 = shyDelay2 = null;
            shyLFO1 = shyLFO2 = shyLFOGain1 = shyLFOGain2 = null;
            shyMix1 = shyMix2 = shyFilter = null;
        }

        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};

        if (visualizerRAF) cancelAnimationFrame(visualizerRAF);
    }

    // ── Audio Processing Chain ───────────────────────────
    function setupAudioProcessing(stream) {
        audioCtx = new AudioContext();
        micSource = audioCtx.createMediaStreamSource(stream);

        gainNode = audioCtx.createGain();
        gainNode.gain.value = volumeSlider.value / 100;

        shyModGain = audioCtx.createGain();
        shyModGain.gain.value = 1;

        dryGain = audioCtx.createGain();
        wetGain = audioCtx.createGain();
        const reverbVal = reverbSlider.value / 100;
        dryGain.gain.value = 1 - reverbVal;
        wetGain.gain.value = reverbVal;

        convolver = audioCtx.createConvolver();
        convolver.buffer = createReverbImpulse(audioCtx, 2.5, 2.0);

        streamDestination = audioCtx.createMediaStreamDestination();
        processedStream = streamDestination.stream;

        micSource.connect(gainNode);
        gainNode.connect(shyModGain);
        shyModGain.connect(dryGain);
        shyModGain.connect(convolver);
        convolver.connect(wetGain);
        dryGain.connect(streamDestination);
        wetGain.connect(streamDestination);
    }

    function createReverbImpulse(ctx, duration, decay) {
        const rate = ctx.sampleRate;
        const length = rate * duration;
        const impulse = ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        return impulse;
    }

    // ── Slider Controls ─────────────────────────────────
    volumeSlider.addEventListener('input', () => {
        const val = volumeSlider.value;
        volumeValue.textContent = val + '%';
        if (gainNode) gainNode.gain.value = val / 100;
    });

    reverbSlider.addEventListener('input', () => {
        const val = reverbSlider.value;
        reverbValue.textContent = val + '%';
        if (dryGain && wetGain) {
            dryGain.gain.value = 1 - val / 100;
            wetGain.gain.value = val / 100;
        }
    });

    // ═══════════════════════════════════════════════════════
    // 9. AUDIO VISUALIZER
    // ═══════════════════════════════════════════════════════

    let visualizerRAF = null;

    function startVisualizer(stream) {
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        src.connect(analyser);

        const bars = audioVisualizer.querySelectorAll('.bar');
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function draw() {
            visualizerRAF = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);
            bars.forEach((bar, i) => {
                const value = dataArray[i * 2] || 0;
                bar.style.height = Math.max(4, value / 8) + 'px';
            });
        }
        draw();
    }

    // ═══════════════════════════════════════════════════════
    // 10. WEBRTC
    // ═══════════════════════════════════════════════════════

    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.relay.metered.ca:80' },
            {
                urls: 'turn:global.relay.metered.ca:80',
                username: 'e8dd65b92f6eae8fe015a101',
                credential: '1laBSosbEq/1GATC'
            },
            {
                urls: 'turn:global.relay.metered.ca:80?transport=tcp',
                username: 'e8dd65b92f6eae8fe015a101',
                credential: '1laBSosbEq/1GATC'
            },
            {
                urls: 'turn:global.relay.metered.ca:443',
                username: 'e8dd65b92f6eae8fe015a101',
                credential: '1laBSosbEq/1GATC'
            },
            {
                urls: 'turns:global.relay.metered.ca:443?transport=tcp',
                username: 'e8dd65b92f6eae8fe015a101',
                credential: '1laBSosbEq/1GATC'
            }
        ]
    };

    function createPeerConnection(targetId, initiator) {
        if (peerConnections[targetId]) return peerConnections[targetId];

        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[targetId] = pc;

        const streamToSend = processedStream || localStream;
        if (streamToSend) {
            streamToSend.getTracks().forEach(track => {
                pc.addTrack(track, streamToSend);
            });
        }

        pc.ontrack = (event) => {
            console.log(`[WebRTC] Received track from ${targetId}`);
            const stream = event.streams[0];

            // Use Audio element for reliable autoplay
            const audio = new Audio();
            audio.srcObject = stream;
            audio.autoplay = true;
            audio.volume = (remoteDelayNodes[targetId]?.volume ?? 100) / 100;
            // Mute the audio element — we route through AudioContext instead
            audio.muted = true;
            audio.play().catch(err => console.error('[WebRTC] Audio play error:', err));

            // Route through AudioContext for delay & gain control
            const ctx = new AudioContext();
            if (ctx.state === 'suspended') ctx.resume();
            const source = ctx.createMediaStreamSource(stream);
            const gainNode = ctx.createGain();
            gainNode.gain.value = (remoteDelayNodes[targetId]?.volume ?? 100) / 100;
            const delayNode = ctx.createDelay(1.0);
            delayNode.delayTime.value = (remoteDelayNodes[targetId]?.delay || 0) / 1000;

            source.connect(gainNode);
            gainNode.connect(delayNode);
            delayNode.connect(ctx.destination);

            remoteDelayNodes[targetId] = {
                audio,
                ctx,
                gainNode,
                delayNode,
                delay: remoteDelayNodes[targetId]?.delay || 0,
                volume: remoteDelayNodes[targetId]?.volume ?? 100
            };
        };

        pc.onconnectionstatechange = () => {
            console.log(`[WebRTC] Connection to ${targetId}: ${pc.connectionState}`);
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`[WebRTC] ICE to ${targetId}: ${pc.iceConnectionState}`);
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc-ice-candidate', { to: targetId, candidate: event.candidate });
            }
        };

        if (initiator) {
            pc.createOffer().then(offer => {
                offer.sdp = setOpusMusic(offer.sdp);
                pc.setLocalDescription(offer);
                socket.emit('webrtc-offer', { to: targetId, offer });
            });
        }

        return pc;
    }

    // Optimize Opus codec for singing: higher bitrate, music mode
    function setOpusMusic(sdp) {
        // Set Opus to music-friendly settings
        // maxaveragebitrate=48000 (48kbps — good singing quality, reasonable bandwidth)
        // stereo=0 (mono to save bandwidth)
        // sprop-stereo=0
        // usedtx=0 (no discontinuous transmission — keeps singing smooth)
        // cbr=1 (constant bitrate — more predictable quality)
        return sdp.replace(
            /a=fmtp:(\d+) /g,
            (match, pt) => {
                // Only modify Opus payload (the one with minptime)
                return match;
            }
        ).replace(
            /a=fmtp:(\d+) minptime=10;useinbandfec=1/g,
            'a=fmtp:$1 minptime=10;useinbandfec=1;maxaveragebitrate=48000;stereo=0;sprop-stereo=0;usedtx=0;cbr=1'
        );
    }

    socket.on('webrtc-offer', async ({ from, offer }) => {
        const pc = createPeerConnection(from, false);
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        answer.sdp = setOpusMusic(answer.sdp);
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-answer', { to: from, answer });
    });

    socket.on('webrtc-answer', async ({ from, answer }) => {
        const pc = peerConnections[from];
        if (pc) await pc.setRemoteDescription(answer);
    });

    socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
        const pc = peerConnections[from];
        if (pc) await pc.addIceCandidate(candidate);
    });

    // ═══════════════════════════════════════════════════════
    // 11. CHAT
    // ═══════════════════════════════════════════════════════

    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const chatSendBtn = document.getElementById('chatSendBtn');

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function sendChat() {
        const text = chatInput.value.trim();
        if (!text) return;
        socket.emit('chat-message', text);
        chatInput.value = '';
        chatInput.focus();
    }

    chatSendBtn.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
    });

    // Emoji reaction buttons
    document.querySelectorAll('.chat-emoji-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            socket.emit('chat-message', btn.dataset.emoji);
        });
    });

    socket.on('chat-message', (msg) => {
        const isMine = msg.socketId === mySocketId;
        const nickClass = msg.isHost ? 'chat-msg__nick--host' : '';
        const nickColor = msg.isHost ? '' : `style="color: ${['#00D4FF', '#A855F7', '#22C55E', '#F59E0B', '#EF4444', '#FF2D8A'][Math.abs(msg.nickname.charCodeAt(0)) % 6]}"`;

        // Animated emoji map
        const emojiMap = {
            '👏': '<span class="emoji-icon">👏</span>',
            '👍': '<span class="emoji-icon">👍</span>',
            '❤️': '<span class="emoji-icon">❤️</span>',
            '갱차나!': '<span class="jump-text"><span class="jump-char">갱</span><span class="jump-char">차</span><span class="jump-char">나</span><span class="jump-char">!</span></span>'
        };
        const animatedText = emojiMap[msg.text] || escapeHtml(msg.text);

        const div = document.createElement('div');
        div.className = `chat-msg ${isMine ? 'chat-msg--mine' : ''}`;
        div.innerHTML = `<span class="chat-msg__nick ${nickClass}" ${nickColor}>${escapeHtml(msg.nickname)}</span><span class="chat-msg__text">${animatedText}</span><span class="chat-msg__time">${msg.time}</span>`;
        chatMessages.appendChild(div);

        // Keep max 200 messages
        while (chatMessages.children.length > 200) {
            chatMessages.removeChild(chatMessages.firstChild);
        }

        // Auto-scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });

    // ═══════════════════════════════════════════════════════
    // 11. ROOM SETTINGS MODAL
    // ═══════════════════════════════════════════════════════

    const settingsModal = document.getElementById('roomSettingsModal');
    const settingsRoomName = document.getElementById('settingsRoomName');
    const settingsPassword = document.getElementById('settingsPassword');
    const settingsMicCount = document.getElementById('settingsMicCount');
    const settingsMaxUsers = document.getElementById('settingsMaxUsers');
    const settingsMaxUsersLabel = document.getElementById('settingsMaxUsersLabel');
    const settingsSaveBtn = document.getElementById('settingsSaveBtn');
    const settingsCancelBtn = document.getElementById('settingsCancelBtn');
    const usersBadge = document.getElementById('usersBadge');

    let settingsSelectedMics = 2;

    // Open settings modal (host only)
    usersBadge.addEventListener('click', () => {
        if (roomHostId !== mySocketId) {
            showToast('방장만 설정을 변경할 수 있습니다.');
            return;
        }
        // Populate current values
        settingsRoomName.value = roomNameEl.textContent;
        settingsPassword.value = '';
        settingsSelectedMics = roomMaxMics;
        settingsMaxUsers.value = roomMaxUsers;
        settingsMaxUsersLabel.textContent = roomMaxUsers + '명';
        updateSettingsMicUI();
        settingsModal.classList.add('active');
    });

    // Mic count selector
    settingsMicCount.addEventListener('click', (e) => {
        const btn = e.target.closest('.settings-mic-opt');
        if (!btn) return;
        settingsSelectedMics = parseInt(btn.dataset.count);
        updateSettingsMicUI();
    });

    function updateSettingsMicUI() {
        settingsMicCount.querySelectorAll('.settings-mic-opt').forEach(btn => {
            if (parseInt(btn.dataset.count) === settingsSelectedMics) {
                btn.classList.remove('btn-secondary');
                btn.classList.add('btn-primary');
            } else {
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-secondary');
            }
        });
    }

    // Max users slider
    settingsMaxUsers.addEventListener('input', () => {
        settingsMaxUsersLabel.textContent = settingsMaxUsers.value + '명';
    });

    // Cancel
    settingsCancelBtn.addEventListener('click', () => {
        settingsModal.classList.remove('active');
    });
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) settingsModal.classList.remove('active');
    });

    // Save
    settingsSaveBtn.addEventListener('click', () => {
        const data = {
            name: settingsRoomName.value.trim(),
            password: settingsPassword.value, // empty string = remove password
            maxMics: settingsSelectedMics,
            maxUsers: parseInt(settingsMaxUsers.value)
        };

        socket.emit('update-room-settings', data, (res) => {
            if (res.error) {
                showToast(res.error);
                return;
            }
            settingsModal.classList.remove('active');
            showToast('✅ 방 설정이 저장되었습니다!');
        });
    });

})();
