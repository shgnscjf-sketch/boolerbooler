const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── YouTube Search API (scraping, no API key needed) ────────
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);

  try {
    const searchQuery = encodeURIComponent(`${query}`);
    const url = `https://www.youtube.com/results?search_query=${searchQuery}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });

    const html = await response.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (!match) {
      console.error('[Search] Could not parse YouTube response');
      return res.json([]);
    }

    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents;

    if (!contents) return res.json([]);

    const results = [];
    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents;
      if (!items) continue;
      for (const item of items) {
        const video = item?.videoRenderer;
        if (!video) continue;
        results.push({
          videoId: video.videoId,
          title: video.title?.runs?.[0]?.text || '',
          channel: video.ownerText?.runs?.[0]?.text || '',
          thumbnail: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`,
          duration: video.lengthText?.simpleText || ''
        });
        if (results.length >= 15) break;
      }
      if (results.length >= 15) break;
    }

    res.json(results);
  } catch (err) {
    console.error('[Search Error]', err.message);
    res.json([]);
  }
});

// ── Room State ──────────────────────────────────────────────
const rooms = new Map();
// Room structure:
// {
//   id, name, users: Map<socketId, {nickname}>,
//   hostId: socketId,          // 방장 (방 만든 사람)
//   maxMics: 1~4,              // 방장이 설정한 마이크 수
//   mics: [null, null, null, null],  // 슬롯별 socketId
//   currentMR: null | {videoId, title, thumbnail}
// }

let roomIdCounter = 1;

// No default rooms — rooms are created by users

// ── Helpers ─────────────────────────────────────────────────
const adjectives = ['신나는', '즐거운', '행복한', '열정적인', '멋진', '화려한', '쿨한', '감성적인', '파워풀한', '귀여운'];
const nouns = ['유저', '스타', '히어로', '플레이어', '아이돌', 'DJ', '크리에이터', '멤버', '루키', '마스터'];
function randomNickname() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj} ${noun}${num}`;
}

function serializeRooms() {
  const list = [];
  rooms.forEach((room) => {
    list.push({
      id: room.id,
      name: room.name,
      userCount: room.users.size,
      maxUsers: room.maxUsers || 20,
      maxMics: room.maxMics,
      hasPassword: !!room.password,
      currentMR: room.currentMR
    });
  });
  return list;
}

function serializeUsers(room) {
  const users = [];
  room.users.forEach((user, socketId) => {
    // Find which mic slot this user holds (-1 = none)
    const micSlot = room.mics.indexOf(socketId);
    users.push({
      socketId,
      nickname: user.nickname,
      isHost: room.hostId === socketId,
      micSlot: micSlot >= 0 && micSlot < room.maxMics ? micSlot : -1
    });
  });
  // Sort: host first, then by mic slot (0,1,2,3), then no-mic users
  users.sort((a, b) => {
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    if (a.micSlot !== -1 && b.micSlot === -1) return -1;
    if (a.micSlot === -1 && b.micSlot !== -1) return 1;
    return a.micSlot - b.micSlot;
  });
  return users;
}

function serializeMics(room) {
  // Return mic slots with user info
  return room.mics.slice(0, room.maxMics).map((socketId, index) => {
    if (!socketId) return { slot: index, socketId: null, nickname: null };
    const user = room.users.get(socketId);
    return { slot: index, socketId, nickname: user?.nickname || '???' };
  });
}

// Release all mics held by a given socketId
function releaseMicsForUser(room, socketId) {
  let changed = false;
  for (let i = 0; i < 4; i++) {
    if (room.mics[i] === socketId) {
      room.mics[i] = null;
      changed = true;
    }
  }
  return changed;
}

// ── Socket.IO ───────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);
  let currentRoomId = null;
  let nickname = randomNickname();

  // Admin check
  const ADMIN_TOKEN = 'bb_owner_2024';

  // Send initial room list
  socket.emit('room-list', serializeRooms());

  // Create room
  socket.on('create-room', (data, callback) => {
    const id = `room_${roomIdCounter++}`;
    const name = (typeof data === 'string' ? data : data?.name)?.trim() || `방 ${id}`;
    const maxMics = Math.max(1, Math.min(4, parseInt(data?.maxMics) || 2));
    const maxUsers = Math.max(2, Math.min(20, parseInt(data?.maxUsers) || 20));
    const password = data?.password?.trim() || null;

    rooms.set(id, {
      id, name,
      users: new Map(),
      hostId: socket.id,
      maxMics,
      maxUsers,
      password,
      mics: [null, null, null, null],
      currentMR: null
    });

    io.emit('room-list', serializeRooms());
    if (callback) callback({ id, name });
  });

  // Join room
  socket.on('join-room', (data, callback) => {
    // Support both string roomId and {roomId, password} object
    const roomId = typeof data === 'string' ? data : data?.roomId;
    const password = typeof data === 'string' ? null : data?.password;
    const adminToken = data?.adminToken;

    // Admin nickname override
    if (adminToken === ADMIN_TOKEN) {
      nickname = '🔥서버주인장🔥';
    }

    const room = rooms.get(roomId);
    if (!room) {
      if (callback) callback({ error: '방을 찾을 수 없습니다.' });
      return;
    }

    // Password check
    if (room.password && room.password !== password) {
      if (callback) callback({ error: 'password-required' });
      return;
    }

    // Max users check
    if (room.users.size >= (room.maxUsers || 20)) {
      if (callback) callback({ error: '방이 가득 찼습니다.' });
      return;
    }

    // Leave previous room if any
    if (currentRoomId) {
      const prevRoom = rooms.get(currentRoomId);
      if (prevRoom) {
        prevRoom.users.delete(socket.id);
        if (releaseMicsForUser(prevRoom, socket.id)) {
          io.to(currentRoomId).emit('mic-slots-updated', serializeMics(prevRoom));
        }
        socket.leave(currentRoomId);
        io.to(currentRoomId).emit('user-left', { socketId: socket.id, nickname });
        io.to(currentRoomId).emit('user-list', serializeUsers(prevRoom));
      }
    }

    currentRoomId = roomId;
    room.users.set(socket.id, { nickname });

    if (!room.hostId || !room.users.has(room.hostId)) {
      room.hostId = socket.id;
    }

    socket.join(roomId);

    io.to(roomId).emit('user-joined', { socketId: socket.id, nickname });
    io.to(roomId).emit('user-list', serializeUsers(room));
    io.emit('room-list', serializeRooms());

    if (callback) callback({
      success: true,
      roomName: room.name,
      nickname,
      users: serializeUsers(room),
      currentMR: room.currentMR,
      hostId: room.hostId,
      maxMics: room.maxMics,
      maxUsers: room.maxUsers || 20,
      hasPassword: !!room.password,
      mics: serializeMics(room)
    });
  });

  // ── Mic Slot Management ─────────────────────────────────
  socket.on('claim-mic', (slotIndex, callback) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const slot = parseInt(slotIndex);
    if (slot < 0 || slot >= room.maxMics) return;

    // Check if user already has a mic
    const existingSlot = room.mics.indexOf(socket.id);
    if (existingSlot !== -1) {
      if (callback) callback({ error: '이미 마이크를 잡고 있습니다. 먼저 놓아주세요.' });
      return;
    }

    // Check if slot is taken
    if (room.mics[slot] !== null) {
      if (callback) callback({ error: '이미 다른 사람이 잡고 있는 마이크입니다.' });
      return;
    }

    room.mics[slot] = socket.id;
    io.to(currentRoomId).emit('mic-slots-updated', serializeMics(room));
    if (callback) callback({ success: true, slot });
  });

  socket.on('release-mic', (slotIndex) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const slot = parseInt(slotIndex);
    if (slot < 0 || slot >= room.maxMics) return;

    // Only the holder can release
    if (room.mics[slot] !== socket.id) return;

    room.mics[slot] = null;
    io.to(currentRoomId).emit('mic-slots-updated', serializeMics(room));
  });

  // ── Play MR (only mic 1 holder) ─────────────────────────
  socket.on('play-mr', (data) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Only mic slot 0 (1번 마이크) can control MR
    if (room.mics[0] !== socket.id) {
      socket.emit('mr-denied', '1번 마이크를 잡은 사람만 영상을 제어할 수 있습니다.');
      return;
    }

    room.currentMR = {
      videoId: data.videoId,
      title: data.title,
      thumbnail: data.thumbnail
    };

    io.to(currentRoomId).emit('mr-changed', room.currentMR);
    io.emit('room-list', serializeRooms());
  });

  // Chat message
  socket.on('chat-message', (text) => {
    if (!currentRoomId || !text?.trim()) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const msg = {
      socketId: socket.id,
      nickname,
      text: text.trim().substring(0, 200),
      isHost: room.hostId === socket.id,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };
    io.to(currentRoomId).emit('chat-message', msg);
  });

  // MR time sync — mic 1 sends their current playback time
  socket.on('sync-mr-time', (data) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.mics[0] !== socket.id) return;  // Only mic 1

    // Broadcast to others in room (except sender)
    socket.to(currentRoomId).emit('sync-mr-time', {
      currentTime: data.currentTime,
      videoId: data.videoId,
      isPlaying: data.isPlaying
    });
  });

  // ── WebRTC Signaling ────────────────────────────────────
  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice-candidate', { from: socket.id, candidate });
  });

  socket.on('mic-status', (isOn) => {
    if (!currentRoomId) return;
    io.to(currentRoomId).emit('user-mic-status', { socketId: socket.id, isOn });
  });

  // ── Update Room Settings (host only) ────────────────
  socket.on('update-room-settings', (data, callback) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      if (callback) callback({ error: '방장만 설정을 변경할 수 있습니다.' });
      return;
    }

    if (data.name?.trim()) room.name = data.name.trim();
    if (data.password !== undefined) room.password = data.password?.trim() || null;
    if (data.maxMics) room.maxMics = Math.max(1, Math.min(4, parseInt(data.maxMics)));
    if (data.maxUsers) room.maxUsers = Math.max(2, Math.min(50, parseInt(data.maxUsers)));

    // Broadcast updated settings
    io.to(currentRoomId).emit('room-settings-updated', {
      roomName: room.name,
      maxMics: room.maxMics,
      maxUsers: room.maxUsers,
      hasPassword: !!room.password
    });
    io.to(currentRoomId).emit('mic-slots-updated', serializeMics(room));
    io.emit('room-list', serializeRooms());
    if (callback) callback({ success: true });
  });

  // ── Host Admin: Kick User ──────────────────────────────
  socket.on('kick-user', (targetSocketId) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.hostId !== socket.id) return; // Only host
    if (targetSocketId === socket.id) return; // Can't kick self

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('kicked', '방장에 의해 강퇴되었습니다.');
      // Force disconnect from room
      room.users.delete(targetSocketId);
      releaseMicsForUser(room, targetSocketId);
      targetSocket.leave(currentRoomId);
      io.to(currentRoomId).emit('mic-slots-updated', serializeMics(room));
      io.to(currentRoomId).emit('user-list', serializeUsers(room));
      io.to(currentRoomId).emit('user-left', {
        socketId: targetSocketId,
        nickname: room.users.get(targetSocketId)?.nickname || ''
      });
      io.emit('room-list', serializeRooms());
    }
  });

  // ── Host Admin: Force Mic Off ──────────────────────────
  socket.on('force-release-mic', (targetSocketId) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.hostId !== socket.id) return; // Only host

    if (releaseMicsForUser(room, targetSocketId)) {
      io.to(currentRoomId).emit('mic-slots-updated', serializeMics(room));
      io.to(currentRoomId).emit('user-list', serializeUsers(room));
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('force-mic-off', '방장이 마이크를 강제로 끄었습니다.');
      }
    }
  });

  // ── Disconnect ──────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.users.delete(socket.id);

        // Release mics held by this user
        if (releaseMicsForUser(room, socket.id)) {
          io.to(currentRoomId).emit('mic-slots-updated', serializeMics(room));
        }

        // If host disconnected, assign new host
        if (room.hostId === socket.id) {
          const nextUser = room.users.keys().next().value;
          room.hostId = nextUser || null;
          if (room.hostId) {
            io.to(currentRoomId).emit('host-changed', room.hostId);
          }
        }

        io.to(currentRoomId).emit('user-left', { socketId: socket.id, nickname });
        io.to(currentRoomId).emit('user-list', serializeUsers(room));

        // Delete room if empty
        if (room.users.size === 0) {
          rooms.delete(currentRoomId);
        }
      }
    }

    // Also clean up any other empty rooms (e.g. password rooms never joined)
    for (const [id, room] of rooms) {
      if (room.users.size === 0) {
        rooms.delete(id);
      }
    }

    io.emit('room-list', serializeRooms());
  });
});

// ── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎤 불러불러 서버 실행 중: http://localhost:${PORT}\n`);
});
