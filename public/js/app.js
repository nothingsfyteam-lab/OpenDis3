(function () {
  // Global Error Handler
  window.addEventListener('error', (e) => {
    console.error('Global Error:', e.message, 'at', e.filename, ':', e.lineno);
  });

  console.log("OwnDC App loading...");

  // --- State ---
  let currentUser = null;
  let socket = null;

  // Navigation Context
  // type: 'home' | 'server'
  // id: null (for home) | serverId
  // channelId: current active channel (text or voice)
  let currentContext = { type: 'home', serverId: null, channelId: null };

  // Data Cache
  let servers = [];
  let channels = []; // Current server's channels
  let friends = [];
  let dms = []; // DM channels
  let members = []; // Current server's members

  // Voice / WebRTC State
  let localStream = null;
  let currentVoiceChannelId = null; // ID of the voice channel we are IN
  let peerConnections = {}; // userId -> RTCPeerConnection (Mesh)
  let peerConnectionCall = null; // RTCPeerConnection (Direct Call)
  let callTargetId = null;
  let localStreamCall = null;

  let isMuted = false;
  let isDeafened = false;

  // --- API Helper ---
  async function api(url, opts = {}) {
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    } catch (e) {
      console.error('API Error:', e);
      throw e;
    }
  }

  // --- Initialization ---
  async function init() {
    try {
      currentUser = await api('/api/auth/me');
      showApp();
    } catch {
      showAuth();
    }
  }

  function showAuth() {
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('main-app').classList.add('hidden');
  }

  function showApp() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('main-app').classList.remove('hidden');

    // Update User Area
    updateUserArea();

    // Connect Socket
    connectSocket();

    // Load Initial Data
    loadServerList();
    openHome(); // Default to Home view
  }

  function updateUserArea() {
    if (!currentUser) return;
    document.getElementById('current-user-name').textContent = currentUser.username;
    document.getElementById('current-user-discriminator').textContent = `#${currentUser.discriminator || '0000'}`;
    const avatarEl = document.getElementById('current-user-avatar');
    if (currentUser.avatar) {
      avatarEl.style.backgroundImage = `url(${currentUser.avatar})`;
      avatarEl.textContent = '';
    } else {
      avatarEl.style.backgroundImage = 'none';
      avatarEl.textContent = currentUser.username[0].toUpperCase();
    }
  }

  // --- Socket.IO ---
  function connectSocket() {
    if (socket) return;
    socket = io();

    socket.on('connect', () => {
      console.log('Socket connected');
    });

    // Chat Events
    socket.on('new-message', (msg) => {
      if (currentContext.channelId === msg.channel_id) {
        appendMessage(msg);
      } else {
        // Notification logic could go here
      }
    });

    socket.on('new-dm', (msg) => {
      // Check if we are in this DM
      // For DMs, channel_id might be distinct or we check sender/receiver
      // Assuming API returns standard message structure
      if (currentContext.type === 'home' && currentContext.channelId === msg.sender_id) {
        // Logic dependent on how DMs are identified. 
        // Using sender_id as channelId for DMs in this simplified version
        appendMessage(msg);
      } else if (msg.sender_id === currentUser.id) {
        // We sent it, handled locally or via ack, but good to receive
        if (currentContext.channelId === msg.receiver_id) appendMessage(msg);
      }
      loadDmList(); // Refresh DM list order/badge
    });

    // Voice Events (Mesh)
    socket.on('voice-room-users', (data) => {
      // user joined, update UI
      if (data.channelId === currentVoiceChannelId) {
        // Re-render voice users if visible
      }
      // Initiate connections if we are in this room
      if (currentVoiceChannelId === data.channelId && data.users) {
        data.users.forEach(u => {
          if (u.id !== currentUser.id) initiateMeshConnection(u.id);
        });
      }
    });

    socket.on('offer', handleMeshOffer);
    socket.on('answer', handleMeshAnswer);
    socket.on('candidate', handleMeshCandidate);

    // Direct Call Events
    socket.on('incoming-call', handleIncomingCall);
    socket.on('call-accepted', handleCallAccepted);
    socket.on('call-rejected', handleCallRejected);
    socket.on('call-ended', handleCallEnded);
    socket.on('call-ice-candidate', handleCallCandidate);

    // Friend Events
    socket.on('friend-request-received', () => {
      showToast('Friend Request', 'You have a new friend request!');
      if (currentContext.type === 'home' && !currentContext.channelId) renderFriendsView();
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });
  }

  // --- Navigation & Rendering ---

  // 1. Sidebar (Server List)
  async function loadServerList() {
    try {
      servers = await api('/api/servers');
      const container = document.getElementById('server-list');
      container.innerHTML = servers.map(s => `
        <div class="server-icon-wrapper ${currentContext.serverId === s.id ? 'active' : ''}" 
             onclick="window.app.openServer('${s.id}')"
             oncontextmenu="window.app.showServerContextMenu(event, '${s.id}')">
          <div class="server-pill"></div>
          <div class="server-icon" style="${s.icon ? `background-image:url(${s.icon})` : ''}">
            ${s.icon ? '' : s.name.substring(0, 2).toUpperCase()}
          </div>
        </div>
        <div class="server-separator"></div>
      `).join('');
    } catch (e) { console.error('Failed to load servers:', e); }
  }

  // 2. Open Home (DMs)
  async function openHome() {
    currentContext = { type: 'home', serverId: null, channelId: null }; // Reset channelId to show Friends view by default

    // UI Updates
    document.querySelectorAll('.server-icon-wrapper').forEach(el => el.classList.remove('active'));
    document.getElementById('server-home').classList.add('active');
    document.getElementById('sidebar-header-text').textContent = 'Direct Messages';

    await loadDmList();
    renderFriendsView(); // Default view
  }

  async function loadDmList() {
    try {
      friends = await api('/api/friends');
      const accepted = friends.filter(f => f.status === 'accepted');

      const container = document.getElementById('channel-list');
      container.innerHTML = `
           <div class="category-header">Direct Messages</div>
           ${accepted.map(f => `
              <div class="channel-item ${currentContext.channelId === f.id ? 'active' : ''}" 
                   onclick="window.app.openDm('${f.id}', '${f.username}')">
                 <div class="channel-icon" style="border-radius:50%;width:24px;height:24px;background:var(--bg-accent);font-size:12px;display:flex;align-items:center;justify-content:center;margin-right:12px;">
                    ${f.avatar ? `<img src="${f.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : f.username[0].toUpperCase()}
                 </div>
                 <div class="channel-name">${f.username}</div>
              </div>
           `).join('')}
        `;
    } catch (e) { console.error(e); }
  }

  window.app.openDm = async (userId, username) => {
    currentContext = { type: 'home', serverId: null, channelId: userId, data: { username } };

    // Update UI active state
    loadDmList(); // Re-render to highlight active

    // Render Chat Header
    document.getElementById('header-icon').textContent = '@';
    document.getElementById('header-title').textContent = username;
    document.getElementById('header-description').textContent = 'Direct Message';

    // Show/Hide Toolbar Buttons
    document.getElementById('btn-start-call').classList.remove('hidden');
    document.getElementById('btn-start-video').classList.remove('hidden');

    renderChatView();

    // Load Messages
    const msgs = await api(`/api/messages/dm/${userId}`);
    renderMessages(msgs);
  }

  // 3. Open Server
  window.app.openServer = async (serverId) => {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;

    currentContext = { type: 'server', serverId: serverId, channelId: null };

    // UI Updates
    document.querySelectorAll('.server-icon-wrapper').forEach(el => el.classList.remove('active'));
    // Find the element and add active - logic in render loop handles re-render, 
    // but simplistic toggle here for responsiveness
    loadServerList();

    document.getElementById('sidebar-header-text').textContent = server.name;

    // Load Channels
    try {
      const chs = await api(`/api/servers/${serverId}/channels`);
      renderChannelList(chs);

      // Auto-open first text channel
      const firstText = chs.find(c => c.type === 'text');
      if (firstText) {
        window.app.openChannel(firstText.id);
      }
    } catch (e) {
      console.error(e);
    }
  }

  function renderChannelList(channels) {
    const container = document.getElementById('channel-list');
    const textChannels = channels.filter(c => c.type === 'text');
    const voiceChannels = channels.filter(c => c.type === 'voice');

    container.innerHTML = `
          <div class="category-header">Text Channels</div>
          ${textChannels.map(c => `
             <div class="channel-item ${currentContext.channelId === c.id ? 'active' : ''}" onclick="window.app.openChannel('${c.id}')">
                <div class="channel-icon">#</div>
                <div class="channel-name">${c.name}</div>
             </div>
          `).join('')}
          
          <div class="category-header" style="margin-top:16px;">Voice Channels</div>
          ${voiceChannels.map(c => `
             <div class="channel-item ${currentContext.channelId === c.id ? 'active' : ''}" onclick="window.app.joinVoiceChannel('${c.id}')">
                <div class="channel-icon">🔊</div>
                <div class="channel-name">${c.name}</div>
             </div>
          `).join('')}
      `;
  }

  window.app.openChannel = async (channelId) => {
    currentContext.channelId = channelId;

    // Re-render list to update active state
    // (Optimization: just toggle class)
    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    // This selection is tricky without IDs, but re-render is safe
    // Ideally fetch channels from cache
    api(`/api/servers/${currentContext.serverId}/channels`).then(chs => renderChannelList(chs));

    const ch = await api(`/api/channels/${channelId}`);

    document.getElementById('header-icon').textContent = '#';
    document.getElementById('header-title').textContent = ch.name;
    document.getElementById('header-description').textContent = ch.description || '';

    document.getElementById('btn-start-call').classList.add('hidden');
    document.getElementById('btn-start-video').classList.add('hidden');

    renderChatView();

    const msgs = await api(`/api/channels/${channelId}/messages`);
    renderMessages(msgs);

    socket.emit('join-channel', channelId);
  }

  // --- Views ---
  function renderFriendsView() {
    // Hide chat
    document.querySelector('.messages-wrapper').innerHTML = ''; // Clear chat
    document.getElementById('friends-view').style.display = 'flex';
    document.getElementById('input-area').style.display = 'none';
    document.getElementById('header-title').textContent = 'Friends';
    document.getElementById('header-icon').textContent = '';

    // Load friends list
    loadFriendsList('all');
  }

  async function loadFriendsList(tab) {
    const list = await api('/api/friends'); // simplistic, real app would filter properly
    const container = document.getElementById('friends-list-container');
    container.innerHTML = list.map(f => `
         <div class="friend-item">
            <div style="display:flex;align-items:center;">
               <div class="user-avatar" style="width:32px;height:32px;margin-right:12px;font-size:14px;">${f.username[0]}</div>
               <span style="font-weight:600;color:var(--header-primary);">${f.username}</span>
            </div>
            <div class="friend-actions">
               <button class="action-btn" title="Message" onclick="window.app.openDm('${f.id}', '${f.username}')">💬</button>
               <button class="action-btn" title="More">⋮</button>
            </div>
         </div>
      `).join('');
  }

  function renderChatView() {
    document.getElementById('friends-view').style.display = 'none';
    document.getElementById('input-area').style.display = 'block';
  }

  function renderMessages(messages) {
    const container = document.getElementById('messages-container');
    container.innerHTML = messages.map(msg => createMessageHTML(msg)).join('');
    container.scrollTop = container.scrollHeight;
  }

  function appendMessage(msg) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.innerHTML = createMessageHTML(msg);
    container.appendChild(div.firstElementChild); // unpack the wrapper if needed
    container.scrollTop = container.scrollHeight;
  }

  function createMessageHTML(msg) {
    const date = new Date(msg.timestamp || Date.now());
    return `
        <div class="message-group">
            <div class="message-avatar">${(msg.username || 'U')[0]}</div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-username">${msg.username}</span>
                    <span class="message-timestamp">${date.toLocaleTimeString()}</span>
                </div>
                <div class="message-text">${msg.content}</div>
            </div>
        </div>
      `;
  }

  // --- Input Handling ---
  const input = document.getElementById('message-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const content = input.value.trim();
      if (!content) return;

      if (currentContext.type === 'home' && currentContext.channelId) {
        // DM
        socket.emit('send-dm', { receiverId: currentContext.channelId, content });
      } else if (currentContext.type === 'server' && currentContext.channelId) {
        // Channel
        socket.emit('send-message', { channelId: currentContext.channelId, content });
      }
      input.value = '';
    }
  });

  // --- Voice & WebRTC (Mesh) ---
  window.app.joinPublicVoice = async () => {
    const channelId = 'public-voice-test-talk';
    if (currentVoiceChannelId === channelId) return window.app.leaveVoice();

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      currentVoiceChannelId = channelId;

      socket.emit('join-voice', channelId);
      showToast('Voice', 'Connected to Public Voice');

      // Visual indicator could be added to sidebar
    } catch (e) {
      alert('Could not access microphone: ' + e.message);
    }
  }

  window.app.joinVoiceChannel = async (channelId) => {
    if (currentVoiceChannelId === channelId) return;
    // Leave previous if exists
    if (currentVoiceChannelId) window.app.leaveVoice();

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      currentVoiceChannelId = channelId;
      socket.emit('join-voice', channelId);
      showToast('Voice', 'Connected to Voice Channel');
    } catch (e) {
      alert('Microphone Access Denied');
    }
  }

  window.app.leaveVoice = () => {
    if (!currentVoiceChannelId) return;
    socket.emit('leave-voice', currentVoiceChannelId);
    currentVoiceChannelId = null;

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    // Close all mesh connections
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};

    showToast('Voice', 'Disconnected');
  }

  // Mesh RTC Handlers (Simple Audio)
  const iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  async function initiateMeshConnection(targetId) {
    if (peerConnections[targetId]) return;

    const pc = new RTCPeerConnection(iceConfig);
    peerConnections[targetId] = pc;

    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('candidate', { to: targetId, candidate: e.candidate });
    }

    pc.ontrack = (e) => {
      const audio = new Audio();
      audio.srcObject = e.streams[0];
      audio.autoplay = true;
      // Clean up on end?
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: targetId, offer, channelId: currentVoiceChannelId });
  }

  async function handleMeshOffer(data) {
    if (!currentVoiceChannelId) return; // Ignore if we left
    const pc = new RTCPeerConnection(iceConfig);
    peerConnections[data.from] = pc;

    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('candidate', { to: data.from, candidate: e.candidate });
    }

    pc.ontrack = (e) => {
      const audio = new Audio();
      audio.srcObject = e.streams[0];
      audio.autoplay = true;
    }

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: data.from, answer });
  }

  async function handleMeshAnswer(data) {
    const pc = peerConnections[data.from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  }

  async function handleMeshCandidate(data) {
    const pc = peerConnections[data.from];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }

  // --- Direct Calls (Video/Audio) ---
  window.app.startCall = async (targetId, withVideo) => {
    targetId = targetId || currentContext.channelId; // If null, use current DM context
    if (!targetId) return;

    callTargetId = targetId;
    document.getElementById('call-overlay').style.display = 'flex';
    document.getElementById('call-status').textContent = 'Calling...';
    document.getElementById('call-placeholder').style.display = 'flex';
    document.getElementById('remote-video').style.display = 'none';

    try {
      localStreamCall = await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
      const localVideo = document.getElementById('local-video');
      localVideo.srcObject = localStreamCall;
      localVideo.style.display = withVideo ? 'block' : 'none';

      setupCallPeerConnection(targetId, true, withVideo);
    } catch (e) {
      alert('Device Error: ' + e.message);
      document.getElementById('call-overlay').style.display = 'none';
    }
  }

  window.app.endCall = () => {
    if (callTargetId) socket.emit('end-call', { to: callTargetId });
    closeCall();
  }

  function closeCall() {
    document.getElementById('call-overlay').style.display = 'none';
    if (localStreamCall) {
      localStreamCall.getTracks().forEach(t => t.stop());
      localStreamCall = null;
    }
    if (peerConnectionCall) {
      peerConnectionCall.close();
      peerConnectionCall = null;
    }
    callTargetId = null;
    document.getElementById('remote-video').srcObject = null;
    document.getElementById('local-video').srcObject = null;
  }

  function setupCallPeerConnection(targetId, isInitiator, withVideo) {
    const pc = new RTCPeerConnection(iceConfig);
    peerConnectionCall = pc;

    if (localStreamCall) {
      localStreamCall.getTracks().forEach(t => pc.addTrack(t, localStreamCall));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('call-ice-candidate', { to: targetId, candidate: e.candidate });
    }

    pc.ontrack = (e) => {
      const remoteVideo = document.getElementById('remote-video');
      remoteVideo.srcObject = e.streams[0];
      remoteVideo.style.display = 'block';
      document.getElementById('call-placeholder').style.display = 'none';
      document.getElementById('call-status').textContent = 'Connected';
    }

    if (isInitiator) {
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socket.emit('call-user', { to: targetId, signal: offer, withVideo });
      });
    }
  }

  // Incoming Call Logic
  function handleIncomingCall(data) {
    const modal = document.getElementById('incoming-call-modal');
    modal.style.display = 'flex';
    document.getElementById('incoming-call-name').textContent = data.callerName || 'User';

    // Store signal for acceptance
    modal.dataset.signal = JSON.stringify(data.signal);
    modal.dataset.from = data.from;
    modal.dataset.withVideo = data.withVideo;

    document.getElementById('ringtone').play().catch(e => { });
  }

  window.app.acceptCall = async () => {
    const modal = document.getElementById('incoming-call-modal');
    const from = modal.dataset.from;
    const signal = JSON.parse(modal.dataset.signal);
    const withVideo = modal.dataset.withVideo === 'true';

    modal.style.display = 'none';
    document.getElementById('ringtone').pause();

    callTargetId = from;
    document.getElementById('call-overlay').style.display = 'flex';

    try {
      localStreamCall = await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
      const localVideo = document.getElementById('local-video');
      localVideo.srcObject = localStreamCall;
      localVideo.style.display = withVideo ? 'block' : 'none';

      const pc = new RTCPeerConnection(iceConfig);
      peerConnectionCall = pc;

      localStreamCall.getTracks().forEach(t => pc.addTrack(t, localStreamCall));

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('call-ice-candidate', { to: from, candidate: e.candidate });
      }

      pc.ontrack = (e) => {
        const remoteVideo = document.getElementById('remote-video');
        remoteVideo.srcObject = e.streams[0];
        remoteVideo.style.display = 'block';
        document.getElementById('call-placeholder').style.display = 'none';
      }

      await pc.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer-call', { to: from, signal: answer });

    } catch (e) {
      console.error(e);
      alert('Error accepting call');
    }
  }

  window.app.rejectCall = () => {
    const modal = document.getElementById('incoming-call-modal');
    const from = modal.dataset.from;
    socket.emit('reject-call', { to: from });
    modal.style.display = 'none';
    document.getElementById('ringtone').pause();
  }

  async function handleCallAccepted(data) {
    if (peerConnectionCall) {
      await peerConnectionCall.setRemoteDescription(new RTCSessionDescription(data.signal));
      document.getElementById('call-status').textContent = 'Connected';
    }
  }

  function handleCallRejected() {
    closeCall();
    showToast('Call', 'Call Rejected');
  }

  function handleCallEnded() {
    closeCall();
    showToast('Call', 'Call Ended');
  }

  async function handleCallCandidate(data) {
    if (peerConnectionCall) {
      try {
        await peerConnectionCall.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) { }
    }
  }

  // --- Toast Notification ---
  function showToast(title, msg) {
    // Implement simple toast
    console.log('Toast:', title, msg);
    const container = document.getElementById('notification-container');
    const d = document.createElement('div');
    d.style.background = '#333';
    d.style.color = '#fff';
    d.style.padding = '12px';
    d.style.marginBottom = '8px';
    d.style.borderRadius = '4px';
    d.textContent = `${title}: ${msg}`;
    container.appendChild(d);
    setTimeout(() => d.remove(), 3000);
  }

  window.app.debugFriends = () => {
    console.log('Friends:', friends);
    console.log('DMs:', dms);
    alert('Debug info logged to console');
  };

  // --- Auth & Modals ---
  // Login/Reg handlers helper
  function attachAuthListeners() {
    console.log('[AUTH] Attaching auth listeners...');

    const loginBtn = document.getElementById('login-btn');
    console.log('[AUTH] Login button found:', !!loginBtn);
    if (loginBtn) {
      loginBtn.onclick = async (event) => {
        console.log('[AUTH] Login button clicked!', event);
        const u = document.getElementById('login-username').value;
        const p = document.getElementById('login-password').value;
        console.log('[AUTH] Attempting login for user:', u);
        try {
          currentUser = await api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
          console.log('[AUTH] Login successful:', currentUser);
          showApp();
        } catch (e) {
          console.error('[AUTH] Login failed:', e);
          document.getElementById('login-error').textContent = e.message;
        }
      };
      // Test if button is clickable
      loginBtn.addEventListener('click', () => console.log('[AUTH] Button click event fired!'));
    } else {
      console.error('[AUTH] Login button NOT FOUND in DOM!');
    }

    const showRegBtn = document.getElementById('show-register');
    console.log('[AUTH] Show register link found:', !!showRegBtn);
    if (showRegBtn) {
      showRegBtn.onclick = () => {
        console.log('[AUTH] Switching to register form');
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
      };
    }

    const showLoginBtn = document.getElementById('show-login');
    console.log('[AUTH] Show login link found:', !!showLoginBtn);
    if (showLoginBtn) {
      showLoginBtn.onclick = () => {
        console.log('[AUTH] Switching to login form');
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('login-form').style.display = 'block';
      };
    }

    const regBtn = document.getElementById('register-btn');
    console.log('[AUTH] Register button found:', !!regBtn);
    if (regBtn) {
      regBtn.onclick = async (event) => {
        console.log('[AUTH] Register button clicked!', event);
        const u = document.getElementById('reg-username').value;
        const e = document.getElementById('reg-email').value;
        const p = document.getElementById('reg-password').value;
        console.log('[AUTH] Attempting registration for user:', u);
        try {
          currentUser = await api('/api/auth/register', { method: 'POST', body: { username: u, email: e, password: p } });
          console.log('[AUTH] Registration successful:', currentUser);
          showApp();
        } catch (err) {
          console.error('[AUTH] Registration failed:', err);
          document.getElementById('register-error').textContent = err.message;
        }
      };
    }

    console.log('[AUTH] All auth listeners attached');
  }

  // Expose App Global
  window.app = window.app || {};
  Object.assign(window.app, {
    openSettings: () => document.getElementById('settings-modal').style.display = 'flex',
    closeSettings: () => document.getElementById('settings-modal').style.display = 'none',
    showAddFriendModal: () => document.getElementById('add-friend-modal').style.display = 'flex',
    sendFriendRequest: async () => {
      const u = document.getElementById('add-friend-username').value;
      try {
        await api('/api/friends/request', { method: 'POST', body: { username: u } });
        document.getElementById('add-friend-modal').style.display = 'none';
        showToast('Success', 'Friend request sent');
      } catch (e) { alert(e.message); }
    },
    // Expose for debugging
    attachAuthListeners,
    init
  });

  // Start - with fallback for already-loaded DOM
  function startApp() {
    console.log('[INIT] Starting app initialization...');
    console.log('[INIT] Document ready state:', document.readyState);
    attachAuthListeners();
    init();
  }

  if (document.readyState === 'loading') {
    console.log('[INIT] DOM still loading, waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    console.log('[INIT] DOM already loaded, starting immediately...');
    startApp();
  }

})();

