(function () {
  // Global Error Handler for UI visibility
  window.addEventListener('error', (e) => {
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.bottom = '0';
    div.style.left = '0';
    div.style.right = '0';
    div.style.background = 'rgba(255,0,0,0.9)';
    div.style.color = 'white';
    div.style.padding = '10px';
    div.style.zIndex = '10001';
    div.style.fontSize = '12px';
    div.textContent = 'JS Error: ' + e.message + ' at ' + e.filename + ':' + e.lineno;
    document.body.appendChild(div);
  });

  console.log("OwnDC App loading...");
  // State
  let currentUser = null;
  let socket = null;
  let currentContext = { type: 'friends', id: null, data: null };
  let currentChannelId = null;
  let currentServerId = null;
  let isMuted = false;
  let isDeafened = false;
  let localStream = null;
  let peerConnections = {}; // userId -> PC
  let currentVoiceChannel = null;
  let voiceStates = {}; // channelId -> [{id, username, avatar}]
  let isRenderingSidebar = false;

  // API helpers
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // Init
  function updateActiveNavState() {
    // Sidebar Items (Channels/DMs/Groups)
    document.querySelectorAll('.nav-sidebar .nav-item').forEach(el => {
      const id = el.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
      const isActive = currentContext.id === id;
      el.classList.toggle('active', isActive);
    });

    // Public Voice Widget Active State
    const publicVoiceWidget = document.querySelector('.public-voice-widget');
    if (publicVoiceWidget) {
      if (currentVoiceChannel === 'public-voice-test-talk') {
        publicVoiceWidget.classList.add('active');
      } else {
        publicVoiceWidget.classList.remove('active');
      }
    }
  }

  async function init() {
    try {
      currentUser = await api('/api/auth/me');
      showApp();
    } catch {
      showAuth();
    }
  }

  // Expose to global scope for HTML access
  window.app = window.app || {};

  // Auth
  function showAuth() {
    document.getElementById('auth-screen').classList.add('active');
    document.getElementById('main-app').classList.remove('active');
  }

  function showApp() {
    document.getElementById('auth-screen').classList.remove('active');
    document.getElementById('main-app').classList.add('active');

    // Sidebar User Info
    document.getElementById('sidebar-username').textContent = currentUser.username;
    document.getElementById('sidebar-avatar-text').textContent = currentUser.username[0].toUpperCase();

    connectSocket();
    openHome();
  }

  // Socket
  function connectSocket() {
    if (socket) return;
    socket = io();

    // --- Core Messaging ---
    socket.on('new-message', (msg) => {
      if (currentContext.type === 'channel' && currentContext.id === msg.channel_id) {
        appendMessage(msg);
      } else {
        showNotification('New Message', `${msg.username}: ${msg.content.substring(0, 30)}...`, 'message');
      }
    });

    socket.on('new-dm', (msg) => {
      if (currentContext.type === 'dm' && (msg.sender_id === currentContext.id || msg.receiver_id === currentContext.id)) {
        appendMessage(msg);
      } else {
        showNotification('New DM', `${msg.username}: ${msg.content.substring(0, 30)}...`, 'dm');
      }
    });

    socket.on('new-group-message', (msg) => {
      if (currentContext.type === 'group' && currentContext.id === msg.group_id) {
        appendMessage(msg);
      } else {
        showNotification('Group Message', `${msg.username}: ${msg.content.substring(0, 30)}...`, 'group');
        loadGroups();
      }
    });

    // --- User Status & Friends ---
    socket.on('user-online', (uid) => {
      if (currentContext.type === 'friends') startFriendTab(currentFriendTab);
      loadDmList();
    });

    socket.on('user-offline', (uid) => {
      if (currentContext.type === 'friends') startFriendTab(currentFriendTab);
      loadDmList();
    });

    socket.on('friend-request-received', () => {
      showNotification('Friend Request', 'Someone sent you a friend request!', 'friend');
      if (currentContext.type === 'friends') startFriendTab('pending');
    });

    socket.on('friend-accepted-sync', () => {
      if (currentContext.type === 'friends') startFriendTab('all');
      loadDmList();
    });

    // --- WebRTC Mesh Signaling ---
    socket.on('voice-room-users', (data) => {
      if (data.users) {
        data.users.forEach(u => {
          if (currentUser && u.id !== currentUser.id) {
            addVoiceUser(u.id, u.username);
            initiateConnection(u.id);
          }
        });
      }
    });

    socket.on('voice-user-joined', (data) => {
      addVoiceUser(data.userId, data.username);
    });

    socket.on('voice-user-left', (data) => {
      removeVoiceUser(data.userId);
      if (peerConnections[data.userId]) {
        peerConnections[data.userId].close();
        delete peerConnections[data.userId];
      }
    });

    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('candidate', handleCandidate);

    // --- Voice State ---
    socket.on('voice-room-update', (data) => {
      voiceStates[data.channelId] = data.users;
      if (data.channelId === 'public-voice-test-talk') {
        renderPublicVoiceUsers(data.users);
      }
    });

    socket.on('voice-states-sync', (states) => {
      voiceStates = { ...voiceStates, ...states };
      if (currentServerId) loadChannels(currentServerId);
    });

    // --- Direct Call Signaling ---
    socket.on('incoming-call', async (data) => {
      if (callTargetId && callTargetId === data.from && peerConnectionCall) {
        try {
          await peerConnectionCall.setRemoteDescription(new RTCSessionDescription(data.signal));
          const answer = await peerConnectionCall.createAnswer();
          await peerConnectionCall.setLocalDescription(answer);
          socket.emit('answer-call', { to: data.from, signal: answer });
        } catch (e) { console.error('Renegotiation failed:', e); }
        return;
      }
      if (callTargetId) {
        socket.emit('reject-call', { to: data.from });
        return;
      }

      console.log('Incoming call from:', data.callerName, 'withVideo:', data.withVideo);
      showNotification('Incoming Call', `${data.callerName} is calling you...`, 'call');
      const modal = document.getElementById('incoming-call-modal');
      if (modal) {
        document.getElementById('caller-name').textContent = data.callerName;
        document.getElementById('caller-avatar').style.backgroundImage = data.callerAvatar ? `url(${data.callerAvatar})` : 'none';
        document.getElementById('caller-avatar').textContent = data.callerAvatar ? '' : data.callerName[0].toUpperCase();
        modal.style.display = 'flex';
        playRingtone();

        document.getElementById('accept-call-btn').onclick = async () => {
          modal.style.display = 'none';
          stopRingtone();
          callTargetId = data.from;
          try {
            // Request video if the caller is using video
            localStreamCall = await navigator.mediaDevices.getUserMedia({ 
              video: data.withVideo !== false, 
              audio: true 
            });
            
            const localVideo = document.getElementById('local-video');
            localVideo.srcObject = localStreamCall;
            localVideo.style.display = data.withVideo !== false ? 'block' : 'none';
            localVideo.muted = true; // Mute local video to prevent echo
            
            console.log('Local media obtained, setting up peer connection');
          } catch (e) {
            console.error('Could not get media:', e);
            alert("Could not access camera/mic: " + e.message);
            // Still try to answer with audio only
            try {
              localStreamCall = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (audioErr) {
              console.error('Could not get audio either:', audioErr);
              return;
            }
          }
          
          // Show call overlay
          document.getElementById('active-call-overlay').style.display = 'block';
          document.getElementById('call-target-name').textContent = data.callerName || 'User';
          document.getElementById('call-target-avatar').textContent = data.callerName ? data.callerName[0].toUpperCase() : '?';
          
          // Setup peer connection and handle the offer
          setupPeerConnection(data.from, false, data.withVideo);
          
          try {
            await peerConnectionCall.setRemoteDescription(new RTCSessionDescription(data.signal));
            console.log('Remote description set, creating answer');
            const answer = await peerConnectionCall.createAnswer();
            await peerConnectionCall.setLocalDescription(answer);
            socket.emit('answer-call', { to: data.from, signal: answer });
            console.log('Answer sent');
          } catch (e) {
            console.error('Error handling call:', e);
          }
        };

        document.getElementById('reject-call-btn').onclick = () => {
          modal.style.display = 'none';
          stopRingtone();
          socket.emit('reject-call', { to: data.from });
        };
      }
    });

    socket.on('call-accepted', async (data) => {
      stopRingtone();
      document.getElementById('call-status').textContent = 'Connected';
      document.getElementById('call-calling-placeholder').style.display = 'none';
      
      const remoteVideo = document.getElementById('remote-video');
      remoteVideo.style.display = 'block';
      remoteVideo.style.width = '100%';
      remoteVideo.style.height = '100%';
      remoteVideo.style.objectFit = 'cover';
      
      if (peerConnectionCall) {
        try {
          await peerConnectionCall.setRemoteDescription(new RTCSessionDescription(data.signal));
          console.log('Call accepted, remote description set');
        } catch (e) { console.error('Error setting remote description:', e); }
      }
    });

    socket.on('call-rejected', () => endCall());
    socket.on('call-ended', () => endCall());

    socket.on('call-ice-candidate', async (data) => {
      if (peerConnectionCall) {
        try {
          await peerConnectionCall.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) { console.error('Error adding ICE candidate:', e); }
      }
    });

    // --- Screen Share events ---
    socket.on('screen-share-started', () => {
      showNotification('Screen Sharing', 'Your friend started sharing their screen', 'info');
      
      // Add screen share indicator to UI
      const videoContainer = document.getElementById('call-video-container');
      if (videoContainer && !document.getElementById('remote-screen-share-indicator')) {
        const indicator = document.createElement('div');
        indicator.id = 'remote-screen-share-indicator';
        indicator.className = 'screen-share-active';
        indicator.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect width="18" height="14" x="3" y="3" rx="2"/>
            <path d="M7 21h10"/>
            <path d="M12 17v4"/>
          </svg>
          Screen Sharing
        `;
        videoContainer.appendChild(indicator);
      }
      
      // Change remote video to contain mode for better screen viewing
      const remoteVideo = document.getElementById('remote-video');
      if (remoteVideo) {
        remoteVideo.style.objectFit = 'contain';
      }
    });

    socket.on('screen-share-stopped', () => {
      showNotification('Screen Sharing', 'Your friend stopped sharing their screen', 'info');
      
      // Remove screen share indicator
      const indicator = document.getElementById('remote-screen-share-indicator');
      if (indicator) {
        indicator.remove();
      }
      
      // Reset remote video to cover mode
      const remoteVideo = document.getElementById('remote-video');
      if (remoteVideo) {
        remoteVideo.style.objectFit = 'cover';
      }
    });

    // --- Channels ---
    socket.on('new-channel', (data) => {
      if (currentContext.type === 'server' && currentServerId === data.serverId) {
        loadChannels(currentServerId);
      }
    });
  }

  // --- Public Voice Rendering ---
  function renderPublicVoiceUsers(users) {
    const container = document.getElementById('public-voice-users');
    const countEl = document.getElementById('public-voice-count');
    if (!container || !countEl) return;

    countEl.textContent = users.length;
    container.innerHTML = users.map(u => `
      <div class="public-avatar" title="${esc(u.username)}">
         ${u.avatar ? `<img src="${u.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : u.username[0].toUpperCase()}
      </div>
    `).join('');
  }

  // --- Sidebar & Servers (Removed) ---
  // renderSidebarNav, openServer, showCreateServerModal, showJoinServerModal removed.



  // --- Channels ---
  async function loadChannels(serverId = null) {
    try {
      const container = document.getElementById('channels-list');
      if (!container) return;

      if (!serverId) {
        container.innerHTML = '';
        loadDmList();
        return;
      }

      const channels = await api(`/api/servers/${serverId}/channels`);

      let html = `
        <div class="menu-label" style="display:flex;justify-content:space-between;align-items:center;">
           Text Channels
           <span style="cursor:pointer;font-size:1.2rem;" onclick="window.app.createChannelPrompt()">+</span>
        </div>`;

      const textChannels = channels.filter(c => c.type === 'text');
      const voiceChannels = channels.filter(c => c.type === 'voice');

      textChannels.forEach(ch => {
        html += `
          <div class="nav-item ${currentContext.id === ch.id ? 'active' : ''}"
               onclick="window.app.openChannel('${ch.id}', 'channel')">
             <span>#</span> ${esc(ch.name)}
          </div>`;
      });

      html += `
        <div class="menu-label" style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;">
           Voice Channels
           <span style="cursor:pointer;font-size:1.2rem;" onclick="window.app.createChannelPrompt('voice')">+</span>
        </div>`;

      voiceChannels.forEach(ch => {
        const usersInRoom = voiceStates[ch.id] || [];
        html += `
            <div class="nav-item voice-channel ${currentContext.id === ch.id ? 'active' : ''}" onclick="window.app.openChannel('${ch.id}', 'voice')">
               <span>🔊</span> ${esc(ch.name)}
            </div>
            <div class="voice-user-list" id="voice-users-${ch.id}">
               ${usersInRoom.map(u => `
                 <div class="voice-user-row">
                    <div class="user-avatar-xs">${u.avatar ? `<img src="${u.avatar}" />` : u.username[0].toUpperCase()}</div>
                    <span>${esc(u.username)}</span>
                 </div>
               `).join('')}
            </div>`;
      });

      container.innerHTML = html;

      // Auto-open first channel if switching to server and none open
      if (textChannels.length > 0 && currentContext.type === 'server' && !currentContext.activeChannelId) {
        const first = textChannels[0];
        currentContext.activeChannelId = first.id;
        openChannel(first.id, 'channel');
      }

      // Sync voice states
      if (serverId && socket) socket.emit('get-voice-states');

    } catch (e) { console.error(e); }
  }

  window.app.createChannelPrompt = async (type = 'text') => {
    const name = prompt(`Channel Name (${type}):`);
    if (name) {
      await api(`/api/channels`, { method: 'POST', body: { name, type, server_id: currentContext.id } });
      loadChannels(currentContext.id);
    }
  };

  async function openChannel(id, type) {
    if (type === 'voice') {
      if (currentVoiceChannel === id) return;

      // Try to find the channel name from the DOM or cache to avoid API call
      const chEl = document.querySelector(`.nav-item[onclick*="'${id}'"]`);
      const name = chEl ? chEl.textContent.replace('🔊', '').trim() : 'Voice Channel';

      if (currentVoiceChannel) leaveVoice();
      currentContext = { type: 'channel', id: id, data: { id, name, type: 'voice' } };
      joinVoice();
      updateActiveNavState();
      return;
    }

    if (type === 'channel') {
      if (currentChannelId === id) return;
      currentChannelId = id;

      const chEl = document.querySelector(`.nav-item[onclick*="'${id}'"]`);
      const name = chEl ? chEl.textContent.replace('#', '').trim() : 'General';

      currentContext = { type: 'channel', id: id, data: { id, name, type: 'text' } };
      updateActiveNavState();

      document.getElementById('welcome-view').style.display = 'none';
      document.getElementById('friends-view').style.display = 'none';
      document.getElementById('chat-view').style.display = 'flex';

      document.getElementById('header-title').textContent = name;
      document.querySelector('.hashtag').textContent = '#';
      document.getElementById('join-voice-btn').style.display = 'none';
      document.getElementById('call-video-btn').style.display = 'none';
      document.getElementById('call-normal-btn').style.display = 'none';
      document.getElementById('delete-group-btn').style.display = 'none';

      const inviteBtn = document.getElementById('header-invite-btn');
      if (inviteBtn) inviteBtn.style.display = 'block';

      try {
        // Join logic (if needed, otherwise socket.emit handles it)
        await api(`/api/channels/${id}/join`, { method: 'POST' });
        const messages = await api(`/api/messages/channel/${id}`);
        renderMessages(messages);
        socket.emit('join-channel', id);
      } catch (e) {
        console.error('Failed to load messages or join channel:', e);
      }
    }
  }

  // --- Settings ---
  function openSettings() {
    document.getElementById('settings-modal').style.display = 'flex';
    document.getElementById('settings-username').textContent = currentUser.username;
    document.getElementById('settings-avatar-preview').textContent = currentUser.username[0].toUpperCase();

    // Fetch fresh profile
    api(`/api/users/${currentUser.id}`).then(u => {
      if (u.bio) document.getElementById('settings-bio-input').value = u.bio;
      if (u.avatar) {
        document.getElementById('settings-avatar-input').value = u.avatar;
        document.getElementById('settings-avatar-preview').textContent = '';
        document.getElementById('settings-avatar-preview').style.backgroundImage = `url(${u.avatar})`;
        document.getElementById('settings-avatar-preview').style.backgroundSize = 'cover';
      }
    });
  }

  // --- Theme Toggle ---
  function setTheme(theme) {
    if (theme === 'light') {
      document.documentElement.style.setProperty('--bg-app', '#ffffff');
      document.documentElement.style.setProperty('--bg-sidebar', '#f2f3f5');
      document.documentElement.style.setProperty('--bg-panel', '#ebedef');
      document.documentElement.style.setProperty('--bg-chat', '#ffffff');
      document.documentElement.style.setProperty('--text-primary', '#060607');
      document.documentElement.style.setProperty('--text-secondary', '#4e5058');
      document.documentElement.style.setProperty('--text-muted', '#5c5e66');
      document.documentElement.style.setProperty('--bg-input', '#ebedef');
      document.documentElement.style.setProperty('--bg-active', '#e3e5e8');
      document.documentElement.style.setProperty('--bg-hover', '#e3e5e8');
      document.documentElement.style.setProperty('--border', '#e3e5e8');
      document.documentElement.style.setProperty('--accent', '#000000'); // Black buttons in light mode
      document.documentElement.style.setProperty('--accent-hover', '#222222');

      document.getElementById('theme-light')?.classList.add('active');
      document.getElementById('theme-dark')?.classList.remove('active');
    } else {
      // Reset to CSS defaults (Dark)
      document.documentElement.style = '';
      document.getElementById('theme-dark')?.classList.add('active');
      document.getElementById('theme-light')?.classList.remove('active');
    }
  }

  // --- Friends Tab ---
  let currentFriendTab = 'all';

  window.app.debugFriends = async () => {
    try {
      const friends = await api('/api/friends');
      const pending = await api('/api/friends/pending');
      alert(`Debug Info:\n- Accepted Friends: ${friends.length}\n- Pending Requests: ${pending.length}\n- Current Tab: ${currentFriendTab}`);
      console.log('Accepted:', friends);
      console.log('Pending:', pending);
    } catch (e) {
      alert('Debug Failed: ' + e.message);
    }
  };

  async function startFriendTab(tab) {
    currentFriendTab = tab;
    document.querySelectorAll('.tab-item').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
      t.style.color = t.dataset.tab === tab ? 'var(--text-primary)' : 'var(--text-muted)';
      t.style.borderBottom = t.dataset.tab === tab ? '2px solid var(--text-primary)' : 'none';
    });

    const container = document.getElementById('friends-list-main');
    if (!container) return;

    let html = '';

    // Pending Server Invites (only on 'all' tab)
    if (tab === 'all') {
      try {
        const invites = await api('/api/servers/invites/me');
        if (invites.length > 0) {
          html += `<div class="menu-label" style="padding:12px;">Pending Server Invites</div>`;
          html += invites.map(inv => `
                <div class="friend-row" style="display:flex;align-items:center;padding:12px;border-top:1px solid var(--border);justify-content:space-between;">
                   <div style="display:flex;align-items:center;gap:12px;">
                      <div class="home-icon-container" style="${inv.server_icon ? `background-image:url(${inv.server_icon});background-size:cover;` : 'background:#333;display:flex;align-items:center;justify-content:center;color:#fff;'} width:40px;height:40px;border-radius:50%;margin:0;">${inv.server_icon ? '' : inv.server_name.substring(0, 2)}</div>
                      <div>
                         <div style="font-weight:600;">${inv.server_name}</div>
                         <div style="font-size:0.85rem;color:var(--text-muted);">Invited by ${inv.inviter_name}</div>
                      </div>
                   </div>
                   <div style="display:flex;gap:8px;">
                      <button class="btn" style="background:var(--success);padding:6px 12px;font-size:0.8rem;" onclick="window.app.acceptServerInvite('${inv.id}')">Accept</button>
                      <button class="btn" style="background:var(--danger);padding:6px 12px;font-size:0.8rem;" onclick="window.app.declineServerInvite('${inv.id}')">Ignore</button>
                   </div>
                </div>
            `).join('');
          html += `<div class="menu-label" style="padding:12px;margin-top:12px;">Friends</div>`;
        }
      } catch (e) { console.error(e); }
    }

    let url = '/api/friends';
    if (tab === 'pending') url = '/api/friends/pending';
    if (tab === 'blocked') url = '/api/friends/blocked';

    try {
      const list = await api(url);
      if (list.length === 0) {
        html += `<div class="empty-state">No ${tab} users found.</div>`;
      } else {
        html += list.map(u => renderFriendRow(u, tab)).join('');
      }
    } catch (e) {
      html += `<div class="empty-state">Error loading friends.</div>`;
    }

    container.innerHTML = html;
  }

  // Define global handlers
  window.app.acceptServerInvite = async (id) => {
    try {
      await api(`/api/servers/invites/${id}/accept`, { method: 'POST' });
      showNotification('Success', 'Joined server!', 'success');
      renderSidebarNav();
      startFriendTab('all');
    } catch (e) { alert(e.message); }
  };

  window.app.declineServerInvite = async (id) => {
    try {
      await api(`/api/servers/invites/${id}/decline`, { method: 'POST' });
      startFriendTab('all');
    } catch (e) { alert(e.message); }
  };

  function renderFriendRow(u, tab) {
    let actions = '';
    if (tab === 'pending') {
      actions = `
           <button class="btn-icon" style="color:var(--success)" onclick="window.app.acceptFriend('${u.friendship_id}')">✔️</button>
           <button class="btn-icon" style="color:var(--danger)" onclick="window.app.declineFriend('${u.friendship_id}')">✖️</button>
          `;
    } else if (tab === 'blocked') {
      actions = `<button class="btn-icon" style="color:var(--danger)" onclick="window.app.declineFriend('${u.friendship_id}')">Unblock</button>`;
    } else {
      actions = `
           <div style="display:flex;gap:4px;">
             <button class="btn-icon" onclick="window.app.openDm('${u.id}', '${esc(u.username)}'); event.stopPropagation();" title="Message">💬</button>
             <button class="btn-icon" onclick="window.app.startCall('${u.id}', false); event.stopPropagation();" title="Voice Call">📞</button>
             <button class="btn-icon" onclick="window.app.startCall('${u.id}', true); event.stopPropagation();" title="Video Call">📹</button>
           </div>
          `;
    }

    const statusColor = u.user_status === 'online' ? 'var(--success)' : (u.user_status === 'idle' ? 'var(--warning)' : '#747f8d');

    return `
        <div class="friend-row" style="display:flex;align-items:center;padding:12px;border-top:1px solid var(--border);justify-content:space-between;cursor:${tab === 'all' ? 'pointer' : 'default'};" onclick="${tab === 'all' ? `window.app.openDm('${u.id}', '${esc(u.username)}')` : ''}">
           <div style="display:flex;align-items:center;gap:12px">
              <div class="user-avatar-sm" style="position:relative;">
                ${u.username[0].toUpperCase()}
                ${tab === 'all' ? `<div class="status-indicator" style="background:${statusColor};position:absolute;bottom:-2px;right:-2px;width:10px;height:10px;"></div>` : ''}
              </div>
              <div>
                 <div style="font-weight:600">${esc(u.username)}</div>
                 <div style="font-size:0.8rem;color:var(--text-muted)">${u.user_status === 'online' ? 'Online' : 'Offline'}</div>
              </div>
           </div>
           <div style="display:flex;gap:8px" onclick="event.stopPropagation();">${actions}</div>
        </div>
        `;
  }

  // --- Friends / DMs / Groups ---
  async function loadHomeChannels() {
    try {
      const channels = await api('/api/channels');
      const container = document.getElementById('home-channels-list');
      if (!container) return;

      // Filter channels without server_id (personal/home channels)
      const homeChannels = channels.filter(c => !c.server_id);

      if (homeChannels.length === 0) {
        container.innerHTML = '<div class="menu-label" style="text-transform:none;font-weight:400;color:var(--text-muted);padding:8px 0;">No channels yet</div>';
      } else {
        container.innerHTML = homeChannels.map(ch => {
          const isVoice = ch.type === 'voice';
          const icon = isVoice ? '🔊' : '#';
          return `
            <div class="nav-item ${currentContext.type === 'channel' && currentContext.id === ch.id ? 'active' : ''}"
                 onclick="window.app.openHomeChannel('${ch.id}', '${ch.type}')"
                 style="display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-radius:4px;margin:2px 0;${currentContext.type === 'channel' && currentContext.id === ch.id ? 'background:var(--bg-active);' : ''}">
              <span style="font-size:1rem;width:20px;text-align:center;">${icon}</span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.9rem;">${esc(ch.name)}</span>
              ${isVoice ? '<span style="font-size:0.7rem;color:var(--success);">●</span>' : ''}
            </div>
          `;
        }).join('');
      }
    } catch (e) {
      console.error('Failed to load home channels:', e);
    }
  }

  window.app.openHomeChannel = async (channelId, type) => {
    if (type === 'voice') {
      openChannel(channelId, 'voice');
    } else {
      openChannel(channelId, 'channel');
    }
  };

  async function loadDmList() {
    try {
      const friends = await api('/api/friends');
      const container = document.getElementById('dm-list-container');
      if (!container) return;

      const accepted = friends.filter(f => f.status === 'accepted');

      if (accepted.length === 0) {
        container.innerHTML = '<div class="menu-label" style="text-transform:none;font-weight:400;">No friends yet</div>';
      } else {
        container.innerHTML = accepted.map(f => `
        <div class="nav-item ${currentContext.type === 'dm' && currentContext.id === f.id ? 'active' : ''}"
             onclick="window.app.openDm('${f.id}','${esc(f.username)}')">
           <div class="user-avatar-sm" style="width:24px;height:24px;font-size:10px;">${(f.username || 'U')[0].toUpperCase()}</div>
           <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.username)}</span>
           <div class="status-indicator-dot" style="background:${f.user_status === 'online' ? 'var(--success)' : 'var(--bg-active)'}"></div>
        </div>
        `).join('');
      }

      loadGroups();
      loadHomeChannels(); // Also load home channels
    } catch (e) {
      console.error('Failed to load DM list:', e);
    }
  }

      loadGroups();
    } catch (e) {
      console.error('Failed to load DM list:', e);
    }
  }

  async function loadGroups() {
    try {
      const groups = await api('/api/groups');
      const container = document.getElementById('groups-list-container');

      let html = '';
      html += groups.map(g => `
        <div class="nav-item ${currentContext.type === 'group' && currentContext.id === g.id ? 'active' : ''}"
             onclick="window.app.openGroup('${g.id}','${esc(g.name)}')">
           <div class="user-avatar-sm" style="width:24px;height:24px;background:var(--accent);font-size:10px;">${g.name[0].toUpperCase()}</div>
           <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(g.name)}</span>
        </div>
        `).join('');

      container.innerHTML = html;
    } catch (e) { console.error(e); }
  }

  async function deleteGroup(groupId) {
    const id = groupId || currentContext.id;
    if (!id) return;

    try {
      await api(`/api/groups/${id}`, { method: 'DELETE' });
      showNotification('Group Deleted', '', 'info');
      openHome();
      loadGroups();
    } catch (e) {
      alert(e.message);
    }
  }

  async function deleteServer(serverId) {
    const id = serverId || currentServerId;
    if (!id) return;
    try {
      await api(`/api/servers/${id}`, { method: 'DELETE' });
      showNotification('Server Deleted', '', 'info');
      openHome();
      renderSidebarNav();
    } catch (e) {
      alert(e.message);
    }
  }

  async function showDeleteConfirmationModal(type, id, name) {
    const modal = document.getElementById('modal-container');
    const confirmBtn = document.getElementById('modal-confirm');

    modal.style.display = 'flex';
    document.getElementById('modal-title').textContent = `Delete ${type === 'server' ? 'Server' : 'Group'}`;
    document.getElementById('modal-body').innerHTML = `
        <div style="text-align:center;padding:16px;">
        <p>Are you sure you want to delete <strong>${esc(name)}</strong>?</p>
        <p style="color:var(--danger);font-size:0.85rem;margin-top:8px;">This action cannot be undone.</p>
      </div>
        `;
    confirmBtn.style.display = 'block';
    confirmBtn.textContent = 'Delete';
    confirmBtn.style.background = 'var(--danger)';
    confirmBtn.onclick = async () => {
      if (type === 'server') await deleteServer(id);
      else await deleteGroup(id);
      modal.style.display = 'none';
      confirmBtn.style.background = ''; // Reset
    };
  }

  async function openHome() {
    currentContext = { type: 'home', id: null, data: null };
    currentServerId = null;
    currentChannelId = null;
    updateActiveNavState();

    // Show home sidebar
    document.getElementById('home-sidebar').style.display = 'block';
    document.getElementById('channels-list').style.display = 'none';

    // Show welcome view in main content area
    document.getElementById('welcome-view').style.display = 'flex';
    document.getElementById('friends-view').style.display = 'none';
    document.getElementById('chat-view').style.display = 'none';

    // Update header
    document.getElementById('nav-header-title').textContent = 'OwnDC';

    // Hide context buttons
    document.getElementById('nav-add-friend-btn').style.display = 'none';
    document.getElementById('header-invite-btn').style.display = 'none';
    document.getElementById('join-voice-btn').style.display = 'none';

    // Load DMs and Groups
    loadDmList();
    loadGroups();
  }

  async function openFriendsView(tab = 'all') {
    currentContext = { type: 'friends', id: null, data: null };
    currentServerId = null;
    currentChannelId = null;
    updateActiveNavState();

    // Show home sidebar (DMs/Groups)
    document.getElementById('home-sidebar').style.display = 'block';
    document.getElementById('channels-list').style.display = 'none';

    // Show friends view, hide others
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-view').style.display = 'flex';
    document.getElementById('chat-view').style.display = 'none';

    // Update header
    document.getElementById('nav-header-title').textContent = 'Friends';

    // Hide context buttons
    document.getElementById('header-invite-btn').style.display = 'none';
    document.getElementById('join-voice-btn').style.display = 'none';

    // Load friends in the current tab
    startFriendTab(currentFriendTab);
  }

  async function openDm(userId, username) {
    currentContext = { type: 'dm', id: userId, data: { username } };
    currentServerId = null;
    currentChannelId = null;
    updateActiveNavState();

    // Hide context buttons
    document.getElementById('nav-add-friend-btn').style.display = 'none';
    document.getElementById('nav-create-group-btn').style.display = 'none';

    document.getElementById('home-sidebar').style.display = 'block';
    document.getElementById('channels-list').style.display = 'none';

    // Show chat view, hide others
    document.getElementById('welcome-view').style.display = 'none';
    document.getElementById('friends-view').style.display = 'none';
    document.getElementById('chat-view').style.display = 'flex';
    document.getElementById('header-title').textContent = username;
    document.querySelector('.hashtag').textContent = '@';
    document.getElementById('join-voice-btn').style.display = 'none';

    const inviteBtn = document.getElementById('header-invite-btn');
    if (inviteBtn) inviteBtn.style.display = 'none';

    document.getElementById('call-video-btn').style.display = 'block';
    document.getElementById('call-video-btn').onclick = () => startCall(userId, true);

    document.getElementById('call-normal-btn').style.display = 'block';
    document.getElementById('call-normal-btn').onclick = () => startCall(userId, false);

    const messages = await api(`/api/messages/dm/${userId}`);
    renderMessages(messages);
  }

  async function openGroup(groupId, name) {
    currentContext = { type: 'group', id: groupId, data: { name } };
    currentServerId = null; // We are in Home context
    currentChannelId = null;

    // Ensure correct sidebar is visible
    document.getElementById('home-sidebar').style.display = 'flex';
    document.getElementById('channels-list').style.display = 'none';

    updateActiveNavState();
    socket.emit('join-group', groupId);

    document.getElementById('nav-add-friend-btn').style.display = 'none';
    document.getElementById('nav-create-group-btn').style.display = 'none';

    document.getElementById('friends-view').style.display = 'none';
    document.getElementById('chat-view').style.display = 'flex';
    document.getElementById('header-title').textContent = name;
    document.querySelector('.hashtag').innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="margin-right:4px;">
          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
        </svg>
        `;
    document.getElementById('join-voice-btn').style.display = 'none';
    document.getElementById('call-video-btn').style.display = 'none';
    const inviteBtn = document.getElementById('header-invite-btn');
    if (inviteBtn) {
      inviteBtn.style.display = 'block';
      // Use addEventListener style for consistency if possible, or update onclick
      inviteBtn.onclick = () => window.app.showGroupInviteModal(groupId);
    }

    const deleteBtn = document.getElementById('delete-group-btn');
    if (deleteBtn) deleteBtn.style.display = 'block';

    const messages = await api(`/api/groups/${groupId}/messages`);
    renderMessages(messages);
  }




  window.app.showGroupInviteModal = async (groupId) => {
    const modal = document.getElementById('group-invite-modal');
    modal.style.display = 'flex';

    try {
      const friends = await api('/api/friends');
      const container = document.getElementById('group-invite-friend-list');

      if (friends.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No friends found.</p>';
      } else {
        container.innerHTML = friends.filter(f => f.status === 'accepted').map(f => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid var(--border);">
            <div style="display:flex;align-items:center;gap:12px;">
              <div class="user-avatar-sm">${f.username[0].toUpperCase()}</div>
              <span>${esc(f.username)}</span>
            </div>
            <button class="btn-primary" style="width:auto;padding:4px 12px;font-size:0.85rem;" onclick="window.app.inviteToGroup('${groupId}', '${f.username}')">Add</button>
          </div>
        `).join('');
      }
    } catch (e) {
      console.error(e);
    }
  };

  window.app.inviteToGroup = async (groupId, username) => {
    try {
      await api(`/api/groups/${groupId}/members`, { method: 'POST', body: { username } });
      alert(`User ${username} added to group!`);
    } catch (e) {
      alert(e.message);
    }
  };

  window.app.showCreateDmModal = () => {
    openFriendsView('all');
  };

  window.app.showCreateGroupModal = () => {
    document.getElementById('create-group-modal').style.display = 'flex';
    document.getElementById('create-group-name').value = '';
  };

  window.app.createGroup = async () => {
    const name = document.getElementById('create-group-name').value.trim();
    if (!name) return;
    try {
      const group = await api('/api/groups', { method: 'POST', body: { name } });
      document.getElementById('create-group-modal').style.display = 'none';
      loadGroups();
      openGroup(group.id, group.name);
    } catch (e) { alert(e.message); }
  };

  window.app.copyInviteCode = () => {
    const input = document.getElementById('server-invite-code');
    input.select();
    document.execCommand('copy');
    alert('Invite code copied to clipboard!');
  };

  window.app.sendServerInvite = (friendId, inviteCode) => {
    alert(`Invite sent to friend! They can join using code: ${inviteCode}`);
  };


  // --- Groups (Simplified: treating as dynamic channels for now or separate context) ---
  // ... omitting group specific UI for brevity in this redesign pass, focusing on Core Channel/DM

  // --- Rendering Messages ---
  function renderMessages(messages) {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    messages.forEach(appendMessage);
    scrollToBottom();
  }

  function appendMessage(msg) {
    const container = document.getElementById('messages-container');
    const date = new Date(msg.timestamp || Date.now());
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = date.toLocaleDateString(); // Could do "Today" logic

    const el = document.createElement('div');
    el.className = 'msg-row';
    el.innerHTML = `
       <div class="msg-avatar">${(msg.username || 'U')[0].toUpperCase()}</div>
       <div class="msg-content-wrapper">
          <div class="msg-header">
             <span class="msg-author">${esc(msg.username)}</span>
             <span class="msg-timestamp">${dateStr} ${timeStr}</span>
          </div>
          <div class="msg-text">${processContent(msg.content)}</div>
       </div>
     `;
    container.appendChild(el);
    scrollToBottom();
  }

  function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
  }

  function processContent(text) {
    if (text.startsWith('data:image/')) {
      return `<img src="${text}" style="max-width:300px;max-height:300px;border-radius:8px;margin-top:8px;display:block;cursor:pointer;" onclick="window.open('${text}')">`;
    }
    return esc(text);
  }

  // --- Image Upload ---
  document.getElementById('image-upload-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result;
      if (currentContext.type === 'channel') {
        socket.emit('send-message', { channelId: currentContext.id, content });
      } else if (currentContext.type === 'dm') {
        socket.emit('send-dm', { receiverId: currentContext.id, content });
      } else if (currentContext.type === 'group') {
        socket.emit('send-group-message', { groupId: currentContext.id, content });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // Reset
  });

  // --- Sending ---
  async function sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    if (!content) return;

    if (currentContext.type === 'channel') {
      socket.emit('send-message', { channelId: currentContext.id, content });
    } else if (currentContext.type === 'dm') {
      socket.emit('send-dm', { receiverId: currentContext.id, content });
    } else if (currentContext.type === 'group') {
      socket.emit('send-group-message', { groupId: currentContext.id, content });
    }
    input.value = '';
  }

  // --- Voice Logic (Simplified) ---
  // --- Voice Logic ---
  window.app.joinPublicVoice = async () => {
    const channelId = 'public-voice-test-talk';
    const name = 'Test-Talk';

    if (currentVoiceChannel === channelId) return;
    if (currentVoiceChannel) leaveVoice();

    // We don't change currentContext.type to 'channel' to verify we stay on friends view
    // But we need joinVoice to work.
    // Let's call joinVoice internal logic directly or modify joinVoice.
    // Modifying joinVoice below to be more flexible.

    currentContext.voiceData = { id: channelId, name: name }; // Temporary storage for voice info
    joinVoice(channelId);
  };

  async function joinVoice(targetId = null) {
    const id = targetId || currentContext.id;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      currentVoiceChannel = id;
      socket.emit('join-voice', id);

      const voiceCard = document.getElementById('voice-card');
      if (voiceCard) {
        voiceCard.style.display = 'flex';
        const name = currentContext.voiceData?.name || currentContext.data?.name || 'Voice Channel';
        document.getElementById('voice-channel-name').textContent = name;
      }
      updateActiveNavState();
    } catch (e) { alert(e.message); }
  }

  function leaveVoice() {
    if (!currentVoiceChannel) return;
    socket.emit('leave-voice', currentVoiceChannel);
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};
    currentVoiceChannel = null;

    // Clear UI
    const voiceCard = document.getElementById('voice-card');
    if (voiceCard) voiceCard.style.display = 'none';
    const voiceUsers = document.getElementById('public-voice-users') || document.getElementById('voice-users');
    if (voiceUsers) voiceUsers.innerHTML = ''; // Clear avatar list
  }

  function addVoiceUser(id, name) {
    // This is for the "Voice Channel" specific view if we were inside one, 
    // but we also have the "Public Voice Widget".
    // For now, this updates the generic voice-users container if it exists.
    const c = document.getElementById('voice-users');
    if (c && !document.getElementById(`vu-${id}`)) {
      const d = document.createElement('div');
      d.id = `vu-${id}`;
      d.className = 'user-avatar-sm';
      d.title = name;
      d.textContent = (name || 'U')[0].toUpperCase();
      c.appendChild(d);
    }

    // Also update Public Voice Widget if applicable
    // (handled by voice-room-update event usually)
  }

  function removeVoiceUser(id) {
    const el = document.getElementById(`vu-${id}`);
    if (el) el.remove();
    // Also remove audio element if exists
    const audio = document.getElementById(`audio-${id}`);
    if (audio) audio.remove();
  }

  // --- WebRTC Mesh Logic ---
  const iceConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  async function initiateConnection(targetId) {
    if (peerConnections[targetId]) return; // Already connected

    const pc = new RTCPeerConnection(iceConfig);
    peerConnections[targetId] = pc;

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('candidate', { to: targetId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      // Create audio element for this user
      let audio = document.getElementById(`audio-${targetId}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${targetId}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = event.streams[0];
      audio.play().catch(e => console.error('Audio play failed:', e));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: targetId, offer, channelId: currentVoiceChannel });
  }

  async function handleOffer(data) {
    const pc = new RTCPeerConnection(iceConfig);
    peerConnections[data.from] = pc;

    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('candidate', { to: data.from, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      let audio = document.getElementById(`audio-${data.from}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${data.from}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = event.streams[0];
      audio.play().catch(e => console.error('Audio play failed:', e));
    };

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: data.from, answer });
  }

  async function handleAnswer(data) {
    const pc = peerConnections[data.from];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  }

  async function handleCandidate(data) {
    const pc = peerConnections[data.from];
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  // --- Ringtone Helpers ---
  window.playRingtone = () => {
    const ringtone = document.getElementById('ringtone');
    if (ringtone) {
      ringtone.currentTime = 0;
      ringtone.loop = true;
      ringtone.play().catch(e => console.log('Ringtone blocked:', e));
    }
  };

  window.stopRingtone = () => {
    const ringtone = document.getElementById('ringtone');
    if (ringtone) {
      ringtone.pause();
      ringtone.currentTime = 0;
    }
  };

  // --- Global Helpers ---
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function showNotification(title, message, type) {
    const container = document.getElementById('notification-container');
    const toast = document.createElement('div');
    toast.className = 'notification-toast';

    let icon = '🔔';
    if (type === 'message' || type === 'dm' || type === 'group') icon = '💬';
    if (type === 'call') icon = '📞';
    if (type === 'friend') icon = '🤝';

    toast.innerHTML = `
      <div class="notification-icon">${icon}</div>
      <div class="notification-info">
        <div class="notification-title">${esc(title)}</div>
        <div class="notification-msg">${esc(message)}</div>
      </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('closing');
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }

  // --- Server Management ---
  async function openServerSettings(serverId) {
    if (!serverId) return;
    document.getElementById('server-settings-modal').style.display = 'flex';
    window.app.switchServerTab('overview');
  }

  window.app.switchServerTab = async (tab) => {
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
    document.getElementById(`st-${tab}`).classList.add('active');

    const content = document.getElementById('server-settings-content');
    const sId = currentContext.id;

    if (tab === 'overview') {
      const s = currentContext.data;
      content.innerHTML = `
           <h2 style="margin-bottom:8px;">${esc(s.name)}</h2>
           <p style="color:var(--text-muted);margin-bottom:24px;">Server ID: ${s.id}</p>
           
           <div class="form-group">
             <label>Invite Your Friends</label>
             <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:12px;">Share an invite code with others to let them join your server.</p>
             <button class="btn-primary" style="width:auto;" onclick="window.app.showInviteModal()">Generate Invite Loop</button>
           </div>
        `;
    }
    if (tab === 'roles') {
      const roles = await api(`/api/servers/${sId}/roles`);
      content.innerHTML = `
           <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
              <h3>Roles</h3>
              <button class="btn-primary" style="width:auto;padding:4px 12px;" onclick="createRolePrompt()">Create Role</button>
           </div>
           ${roles.map(r => `<div style="padding:8px;border:1px solid var(--border);margin-bottom:8px;border-radius:4px;display:flex;align-items:center;">
               <div style="width:16px;height:16px;border-radius:50%;background:${r.color};margin-right:12px;"></div>
               <span style="font-weight:600;">${esc(r.name)}</span>
           </div>`).join('')}
        `;
    }
    if (tab === 'members') {
      const members = await api(`/api/servers/${sId}/members`);
      const server = await api(`/api/servers`);
      const currentServer = server.find(s => s.id === sId);
      const isOwner = currentServer && currentServer.owner_id === currentUser.id;

      content.innerHTML = `
           <h3>Members - ${members.length}</h3>
           ${members.map(m => `
             <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid var(--border);">
                <div style="display:flex;align-items:center;gap:12px;">
                   <div class="user-avatar-sm" style="${m.avatar ? `background-image:url(${m.avatar});background-size:cover;` : ''}">${m.avatar ? '' : m.username[0].toUpperCase()}</div>
                   <div>
                      <div style="font-weight:600;color:${m.role_color || 'var(--text-primary)'};">${esc(m.username)}</div>
                      <div style="font-size:0.8rem;color:var(--text-muted);">${m.role_name || 'No Role'}</div>
                   </div>
                </div>
                ${m.id !== currentUser.id && isOwner ? `
                  <div class="dropdown" style="position:relative;">
                    <button class="btn-icon" onclick="toggleMemberMenu('${m.id}')" style="color:var(--text-secondary);">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="2"/>
                        <circle cx="12" cy="12" r="2"/>
                        <circle cx="12" cy="19" r="2"/>
                      </svg>
                    </button>
                    <div id="member-menu-${m.id}" class="dropdown-menu" style="display:none;position:absolute;right:0;top:100%;background:var(--bg-sidebar);border:1px solid var(--border);border-radius:8px;padding:8px;min-width:150px;z-index:100;box-shadow:var(--shadow-lg);">
                      <div class="dropdown-item" onclick="kickUser('${m.id}')" style="padding:8px 12px;cursor:pointer;border-radius:4px;color:var(--danger);font-weight:500;">
                        Kick ${esc(m.username)}
                      </div>
                      <div class="dropdown-item" onclick="muteUser('${m.id}')" style="padding:8px 12px;cursor:pointer;border-radius:4px;margin-top:4px;">
                        Mute Member
                      </div>
                      <div class="dropdown-item" onclick="timeoutUser('${m.id}')" style="padding:8px 12px;cursor:pointer;border-radius:4px;margin-top:4px;">
                        Timeout (5 min)
                      </div>
                    </div>
                  </div>
                ` : ''}
             </div>
           `).join('')}
        `;
    }
  };

  window.createRolePrompt = async () => {
    const name = prompt("Role Name:");
    const color = prompt("Color (Hex):", "#FF0000");
    if (name) {
      await api(`/api/servers/${currentContext.id}/roles`, { method: 'POST', body: { name, color } });
      window.app.switchServerTab('roles');
    }
  };

  window.kickUser = async (uid) => {
    if (confirm('Kick this user?')) {
      await api(`/api/servers/${currentContext.id}/kick`, { method: 'POST', body: { userId: uid } });
      window.app.switchServerTab('members');
    }
  };

  window.toggleMemberMenu = (memberId) => {
    const menu = document.getElementById(`member-menu-${memberId}`);
    if (menu) {
      // Close all other menus
      document.querySelectorAll('.dropdown-menu').forEach(m => {
        if (m.id !== `member-menu-${memberId}`) m.style.display = 'none';
      });
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
  };

  window.muteUser = async (uid) => {
    // For now, just show an alert. In a real app, you'd implement server-side muting
    alert('Mute functionality would be implemented here. This would prevent the user from sending messages.');
    const menu = document.getElementById(`member-menu-${uid}`);
    if (menu) menu.style.display = 'none';
  };

  window.timeoutUser = async (uid) => {
    // For now, just show an alert. In a real app, you'd implement server-side timeouts
    alert('Timeout functionality would be implemented here. This would temporarily restrict the user for 5 minutes.');
    const menu = document.getElementById(`member-menu-${uid}`);
    if (menu) menu.style.display = 'none';
  };

  // --- Direct Calls (WebRTC) ---
  let localStreamCall = null;
  let peerConnectionCall = null;
  let callTargetId = null;

  async function startCall(targetId, withVideo = true) {
    callTargetId = targetId;

    // Start Ringing
    const ringtone = document.getElementById('ringtone');
    if (ringtone) {
      ringtone.loop = true;
      ringtone.play().catch(e => console.log("Ringtone blocked"));
    }

    // Lookup target name for UI
    const targetName = currentContext.data?.username || 'User';
    document.getElementById('call-target-name').textContent = targetName;
    document.getElementById('call-target-avatar').textContent = targetName[0].toUpperCase();
    document.getElementById('call-status').textContent = 'Calling...';
    document.getElementById('call-calling-placeholder').style.display = 'flex';
    document.getElementById('remote-video').style.display = 'none';

    // Show Overlay with "Calling..." status
    document.getElementById('active-call-overlay').style.display = 'block';
    document.getElementById('local-video').style.display = withVideo ? 'block' : 'none';

    try {
      localStreamCall = await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
      document.getElementById('local-video').srcObject = localStreamCall;
      setupPeerConnection(targetId, true, withVideo);
    } catch (e) {
      alert('Could not access camera/mic');
      console.error(e);
      if (ringtone) ringtone.pause();
      document.getElementById('active-call-overlay').style.display = 'none';
    }
  }

  function setupPeerConnection(targetId, isInitiator, withVideo) {
    if (peerConnectionCall) {
      peerConnectionCall.close();
    }

    peerConnectionCall = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    });

    if (localStreamCall) {
      localStreamCall.getTracks().forEach(track => {
        try {
          console.log('Adding track to peer connection:', track.kind);
          peerConnectionCall.addTrack(track, localStreamCall);
        } catch (e) {
          console.error('Error adding track:', e);
        }
      });
    }

    peerConnectionCall.ontrack = (event) => {
      console.log('Received remote track:', event.track.kind);
      const remoteVideo = document.getElementById('remote-video');
      const remoteStream = event.streams[0];
      
      if (remoteVideo && remoteStream) {
        console.log('Setting remote video stream');
        remoteVideo.srcObject = remoteStream;
        remoteVideo.style.display = 'block';
        remoteVideo.style.width = '100%';
        remoteVideo.style.height = '100%';
        remoteVideo.style.objectFit = 'cover';
        
        // Play the video
        remoteVideo.play().then(() => {
          console.log('Remote video playing');
        }).catch(e => {
          console.error('Remote video play failed:', e);
          // Try playing again after user interaction
          document.addEventListener('click', function playVideo() {
            remoteVideo.play().catch(() => {});
            document.removeEventListener('click', playVideo);
          }, { once: true });
        });
        
        // Hide placeholder
        document.getElementById('call-calling-placeholder').style.display = 'none';
        document.getElementById('call-status').textContent = 'Connected';
      }
    };

    peerConnectionCall.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('Sending ICE candidate');
        socket.emit('call-ice-candidate', { to: targetId, candidate: event.candidate });
      }
    };

    peerConnectionCall.onconnectionstatechange = () => {
      console.log('Connection state:', peerConnectionCall.connectionState);
      if (peerConnectionCall.connectionState === 'connected') {
        document.getElementById('call-status').textContent = 'Connected';
        startCallDurationTimer();
      } else if (peerConnectionCall.connectionState === 'disconnected' || peerConnectionCall.connectionState === 'failed') {
        showNotification('Connection Lost', 'The call connection was lost', 'error');
        endCall();
      }
    };

    peerConnectionCall.onnegotiationneeded = () => {
      console.log('Negotiation needed');
    };

    if (isInitiator) {
      peerConnectionCall.createOffer().then(offer => {
        peerConnectionCall.setLocalDescription(offer);
        console.log('Sending call offer with video:', withVideo);
        socket.emit('call-user', { to: targetId, signal: offer, withVideo });
      }).catch(e => {
        console.error('Error creating offer:', e);
      });
    }
  }

  let callDurationInterval = null;

  function startCallDurationTimer() {
    let seconds = 0;
    const durationEl = document.getElementById('call-duration');
    if (!durationEl) return;

    if (callDurationInterval) clearInterval(callDurationInterval);

    callDurationInterval = setInterval(() => {
      seconds++;
      const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
      const secs = (seconds % 60).toString().padStart(2, '0');
      durationEl.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function stopCallDurationTimer() {
    if (callDurationInterval) {
      clearInterval(callDurationInterval);
      callDurationInterval = null;
    }
    const durationEl = document.getElementById('call-duration');
    if (durationEl) durationEl.textContent = '00:00';
  }

  // Call UI Buttons
  document.getElementById('end-call-btn').onclick = () => endCall();

  async function endCall() {
    if (callTargetId) {
      socket.emit('end-call', { to: callTargetId });
    }

    if (localStreamCall) {
      localStreamCall.getTracks().forEach(t => t.stop());
      localStreamCall = null;
    }
    if (peerConnectionCall) {
      peerConnectionCall.close();
      peerConnectionCall = null;
    }
    const ringtone = document.getElementById('ringtone');
    if (ringtone) ringtone.pause();

    document.getElementById('active-call-overlay').style.display = 'none';
    document.getElementById('remote-video').srcObject = null;
    document.getElementById('local-video').srcObject = null;
    document.getElementById('call-target-name').textContent = 'User';
    document.getElementById('call-target-avatar').textContent = '?';

    // Reset button states
    document.getElementById('toggle-mic').style.background = 'rgba(255,255,255,0.1)';
    document.getElementById('toggle-video').style.background = 'rgba(255,255,255,0.1)';
    document.getElementById('share-screen').classList.remove('active');

    stopCallDurationTimer();

    callTargetId = null;
    showNotification('Call Ended', 'The call has ended', 'info');
  }

  document.getElementById('toggle-mic').onclick = () => {
    if (localStreamCall) {
      const audioTrack = localStreamCall.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        document.getElementById('toggle-mic').style.background = audioTrack.enabled ? 'rgba(255,255,255,0.1)' : 'var(--danger)';
      }
    }
  };

  document.getElementById('toggle-video').onclick = () => {
    if (localStreamCall) {
      const videoTrack = localStreamCall.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        document.getElementById('toggle-video').style.background = videoTrack.enabled ? 'rgba(255,255,255,0.1)' : 'var(--danger)';
        document.getElementById('local-video').style.display = videoTrack.enabled ? 'block' : 'none';
      }
    }
  };

  async function shareScreen() {
    try {
      // Check if already sharing screen
      const shareBtn = document.getElementById('share-screen');
      const isSharing = shareBtn.classList.contains('active');

      if (isSharing) {
        // Stop sharing and return to camera
        if (localStreamCall) {
          const videoTrack = localStreamCall.getVideoTracks()[0];
          const sender = peerConnectionCall.getSenders().find(s => s.track?.kind === 'video');
          if (sender && videoTrack) {
            await sender.replaceTrack(videoTrack);
            console.log('Switched back to camera');
          }
        }
        shareBtn.classList.remove('active');
        shareBtn.style.background = 'rgba(255,255,255,0.1)';
        
        // Remove local indicator
        const localIndicator = document.getElementById('local-screen-share-indicator');
        if (localIndicator) localIndicator.remove();
        
        if (callTargetId) socket.emit('screen-share-stopped', { to: callTargetId });
        showNotification('Screen Sharing', 'Screen sharing stopped', 'info');
        return;
      }

      console.log('Starting screen share...');
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ 
        video: { cursor: 'always' }, 
        audio: true 
      });
      const screenTrack = screenStream.getVideoTracks()[0];

      if (peerConnectionCall) {
        const sender = peerConnectionCall.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
          console.log('Screen track added to peer connection');
        }
      }

      // Add local indicator
      const videoContainer = document.getElementById('call-video-container');
      if (videoContainer && !document.getElementById('local-screen-share-indicator')) {
        const indicator = document.createElement('div');
        indicator.id = 'local-screen-share-indicator';
        indicator.className = 'screen-share-active';
        indicator.style.right = '16px';
        indicator.style.left = 'auto';
        indicator.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect width="18" height="14" x="3" y="3" rx="2"/>
            <path d="M7 21h10"/>
            <path d="M12 17v4"/>
          </svg>
          You're Sharing
        `;
        videoContainer.appendChild(indicator);
      }

      shareBtn.classList.add('active');
      shareBtn.style.background = 'var(--success)';
      if (callTargetId) socket.emit('screen-share-started', { to: callTargetId });
      showNotification('Screen Sharing', 'You are now sharing your screen', 'success');

      screenTrack.onended = async () => {
        console.log('Screen share ended by user');
        shareBtn.classList.remove('active');
        shareBtn.style.background = 'rgba(255,255,255,0.1)';
        
        // Remove local indicator
        const localIndicator = document.getElementById('local-screen-share-indicator');
        if (localIndicator) localIndicator.remove();
        
        if (callTargetId) socket.emit('screen-share-stopped', { to: callTargetId });

        if (localStreamCall) {
          const videoTrack = localStreamCall.getVideoTracks()[0];
          const sender = peerConnectionCall?.getSenders().find(s => s.track?.kind === 'video');
          if (sender && videoTrack) {
            await sender.replaceTrack(videoTrack);
            console.log('Switched back to camera after screen share ended');
          }
        }

        showNotification('Screen Sharing', 'Screen sharing ended', 'info');
      };
    } catch (e) {
      console.error('Screen share error:', e);
      showNotification('Error', 'Could not start screen sharing: ' + e.message, 'error');
    }
  }
  document.getElementById('share-screen').onclick = shareScreen;

  window.toggleCallFullscreen = () => {
    const overlay = document.getElementById('active-call-overlay');
    if (!document.fullscreenElement) {
      overlay.classList.add('fullscreen');
      overlay.requestFullscreen().catch(err => {
        console.error('Fullscreen error:', err);
        // Fallback: just expand the overlay without fullscreen API
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.right = '0';
        overlay.style.bottom = '0';
        overlay.style.width = '100vw';
        overlay.style.height = '100vh';
        overlay.style.zIndex = '9999';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.background = '#000';
      });
    } else {
      overlay.classList.remove('fullscreen');
      document.exitFullscreen();
      // Reset inline styles
      overlay.style = '';
      overlay.style.display = 'none';
    }
  };

  // Global helper exposures
  Object.assign(window.app, {
    openChannel, openDm, openGroup, openFriendsView,
    startCall: async (targetId, withVideo = true) => {
      // If targetId is passed directly (from friends list), fetch user info
      if (!currentContext.data || currentContext.type !== 'dm' || currentContext.id !== targetId) {
        try {
          const user = await api(`/api/users/${targetId}`);
          currentContext = { type: 'dm', id: targetId, data: { username: user.username, ...user } };
        } catch (e) {
          console.error('Could not fetch user info:', e);
          currentContext = { type: 'dm', id: targetId, data: { username: 'User' } };
        }
      }
      await startCall(targetId, withVideo);
    },
    openServerSettings,
    endCall,
    shareScreen,
    acceptFriend: async (id) => {
      try {
        const res = await api('/api/friends/accept', { method: 'POST', body: { friendshipId: id } });
        socket.emit('friend-accepted', { targetUserId: res.otherUserId });
        startFriendTab('all');
        loadDmList();
      } catch (e) {
        alert(e.message);
      }
    },
    declineFriend: async (id) => {
      try {
        await api('/api/friends/decline', { method: 'POST', body: { friendshipId: id } });
        startFriendTab(currentFriendTab);
        loadDmList();
      } catch (e) {
        alert(e.message);
      }
    },
    showAddFriendModal,
    showCreateServerModal,
    showJoinServerModal,
    showInviteModal,
    showGroupInviteModal,
    openHome,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    deleteServer,
    showDeleteConfirmationModal
  });

  // Helper for notifications if not standard
  function showNotification(title, body, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `notification notification-${type}`;
    div.style.background = 'var(--bg-panel)';
    div.style.padding = '12px 16px';
    div.style.borderRadius = 'var(--radius)';
    div.style.border = '1px solid var(--border)';
    div.style.boxShadow = 'var(--shadow-lg)';
    div.style.marginBottom = '8px';
    div.style.color = 'var(--text-primary)';
    div.style.pointerEvents = 'auto';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.gap = '4px';
    div.style.animation = 'slideIn 0.3s ease-out';

    div.innerHTML = `
      <div style="font-weight:700;font-size:0.9rem;">${title}</div>
      <div style="font-size:0.8rem;color:var(--text-secondary);">${body}</div>
    `;

    container.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      div.style.transform = 'translateY(-10px)';
      div.style.transition = 'all 0.3s ease-in';
      setTimeout(() => div.remove(), 300);
    }, 4000);
  }

  function toggleMute() {
    isMuted = !isMuted;
    const btn = document.getElementById('user-mute-btn');
    if (btn) {
      btn.classList.toggle('active', isMuted);
      btn.style.color = isMuted ? 'var(--danger)' : 'var(--text-secondary)';
      btn.querySelector('svg').style.stroke = isMuted ? 'var(--danger)' : 'currentColor';
    }
    if (localStream) {
      localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    }
    if (localStreamCall) {
      localStreamCall.getAudioTracks().forEach(t => t.enabled = !isMuted);
    }
    showNotification(isMuted ? 'Microphone Muted' : 'Microphone Unmuted', '', 'info');
  }

  function toggleDeafen() {
    isDeafened = !isDeafened;
    const btn = document.getElementById('user-deafen-btn');
    if (btn) {
      btn.classList.toggle('active', isDeafened);
      btn.style.color = isDeafened ? 'var(--danger)' : 'var(--text-secondary)';
    }
    // Logic to mute remote audio if needed
    document.querySelectorAll('video, audio').forEach(el => {
      if (el.id !== 'ringtone') el.muted = isDeafened;
    });
    showNotification(isDeafened ? 'Audio Deafened' : 'Audio Undeafened', '', 'info');
  }

  function showAddFriendModal() {
    document.getElementById('modal-container').style.display = 'flex';
    document.getElementById('modal-title').textContent = 'Add Friend';
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Username</label>
        <input id="m-username" placeholder="Enter username (e.g. Alex)" autocomplete="off">
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:8px;">You can add friends with their username.</p>
      </div>
    `;
    document.getElementById('modal-confirm').style.display = 'block';
    document.getElementById('modal-confirm').textContent = 'Send Friend Request';
    document.getElementById('modal-confirm').onclick = async () => {
      const u = document.getElementById('m-username').value;
      if (u) {
        try {
          await api('/api/friends/request', { method: 'POST', body: { username: u } });
          document.getElementById('modal-container').style.display = 'none';
          alert('Friend request sent!');
        } catch (e) {
          alert(e.message);
        }
      }
    };
  }

  async function showCreateServerModal() {
    document.getElementById('m-server-name') && (document.getElementById('m-server-name').value = '');
    document.getElementById('modal-container').style.display = 'flex';
    document.getElementById('modal-title').textContent = 'Create Server';
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Server Name</label>
        <input id="m-server-name" placeholder="My Awesome Server">
      </div>
    `;
    document.getElementById('modal-confirm').style.display = 'block';
    document.getElementById('modal-confirm').textContent = 'Create Server';
    document.getElementById('modal-confirm').onclick = async () => {
      const name = document.getElementById('m-server-name').value;
      if (name) {
        const srv = await api('/api/servers', { method: 'POST', body: { name } });
        renderSidebarNav();
        document.getElementById('modal-container').style.display = 'none';
        openServer(srv);
      }
    };
  }

  function showJoinServerModal() {
    document.getElementById('modal-container').style.display = 'flex';
    document.getElementById('modal-title').textContent = 'Join a Server';
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Invite Code</label>
        <input id="m-invite-code" placeholder="Enter an invite code">
      </div>
    `;
    document.getElementById('modal-confirm').style.display = 'block';
    document.getElementById('modal-confirm').textContent = 'Join Server';
    document.getElementById('modal-confirm').onclick = async () => {
      const code = document.getElementById('m-invite-code').value;
      if (code) {
        try {
          await api(`/api/servers/join`, { method: 'POST', body: { code } });
          renderSidebarNav();
          document.getElementById('modal-container').style.display = 'none';
        } catch (e) { alert(e.message); }
      }
    };
  }

  async function showInviteModal() {
    if (!currentContext || (currentContext.type !== 'server' && (currentContext.type !== 'channel' || !currentServerId))) {
      alert('Please select a server first to invite friends!');
      return;
    }

    const srvId = currentContext.type === 'server' ? currentContext.id : currentServerId;

    document.getElementById('modal-container').style.display = 'flex';
    document.getElementById('modal-title').textContent = 'Invite Friends';
    document.getElementById('modal-body').innerHTML = '<p style="text-align:center;">Generating invite link...</p>';
    document.getElementById('modal-confirm').style.display = 'none';

    try {
      const inviteData = await api(`/api/servers/${srvId}/invite`, { method: 'POST' });
      const inviteLink = `${window.location.origin}/invite/${inviteData.code}`;
      const friends = await api('/api/friends');
      const accepted = friends.filter(f => f.status === 'accepted');

      document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
          <label>Invite Link</label>
          <div style="display:flex;gap:8px;">
            <input id="m-invite-link" value="${inviteLink}" readonly style="flex:1;">
            <button class="btn-primary" style="width:auto;white-space:nowrap;" onclick="navigator.clipboard.writeText('${inviteLink}');this.textContent='Copied!';">Copy</button>
          </div>
          <p style="font-size:0.75rem;color:var(--text-muted);margin-top:8px;">Or invite your friends directly below.</p>
        </div>
        <div class="friend-invite-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-top:16px;">
          ${accepted.length === 0 ? '<p style="padding:16px;text-align:center;color:var(--text-muted);">No friends to invite yet.</p>' : accepted.map(f => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid var(--border);">
              <div style="display:flex;align-items:center;gap:12px;">
                <div class="user-avatar-sm" style="width:32px;height:32px;">${f.username[0].toUpperCase()}</div>
                <div style="font-weight:600;">${esc(f.username)}</div>
              </div>
              <button class="btn-primary" style="width:auto;padding:6px 16px;font-size:0.8rem;" onclick="window.app.sendServerInvite('${srvId}', '${f.id}', this)">Invite</button>
            </div>
          `).join('')}
        </div>
      `;
    } catch (e) {
      document.getElementById('modal-body').innerHTML = `<p style="color:var(--danger);text-align:center;">${esc(e.message)}</p>`;
    }
  }

  window.app.sendServerInvite = async (serverId, userId, btn) => {
    try {
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Sending...';
        btn.disabled = true;
      }

      await api(`/api/servers/${serverId}/invite-user`, { method: 'POST', body: { userId } });

      if (btn) {
        btn.textContent = 'Sent!';
        btn.style.background = 'var(--bg-active)';
        btn.style.color = 'var(--text-muted)';
      }
      showNotification('Invite Sent', 'Your friend has been invited to the server!', 'success');
    } catch (e) {
      console.error(e);
      if (btn) {
        btn.textContent = 'Failed';
        btn.style.background = 'var(--danger)';
        setTimeout(() => {
          btn.textContent = 'Invite';
          btn.disabled = false;
          btn.style.background = '';
        }, 2000);
      }
      alert(e.message);
    }
  };

  async function showGroupInviteModal() {
    if (!currentContext || currentContext.type !== 'group') return;

    document.getElementById('modal-container').style.display = 'flex';
    document.getElementById('modal-title').textContent = 'Invite to Group';
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Invite Link</label>
        <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px;">Share this link to invite people to this group.</p>
        <div style="display:flex;gap:8px;">
          <input id="m-group-invite-link" value="${window.location.origin}/group-invite/${currentContext.id}" readonly style="flex:1;">
          <button class="btn-primary" style="width:auto;white-space:nowrap;" onclick="navigator.clipboard.writeText(document.getElementById('m-group-invite-link').value);this.textContent='Copied!';">Copy</button>
        </div>
      </div>
    `;
    document.getElementById('modal-confirm').style.display = 'none';
  }

  // Initializing handlers and starting app
  function startApp() {
    console.log("Initializing UI handlers...");
    init();

    // Home Icon Click
    const homeIcon = document.querySelector('.home-icon-container');
    if (homeIcon) homeIcon.onclick = openHome;

    // Friends Button Click
    const friendsBtn = document.getElementById('sidebar-friends-btn');
    if (friendsBtn) friendsBtn.onclick = openFriendsView;

    // Sidebar Server Actions
    document.getElementById('sidebar-create-server-btn')?.addEventListener('click', () => showCreateServerModal());
    document.getElementById('sidebar-join-server-btn')?.addEventListener('click', () => showJoinServerModal());

    // Message Input
    const msgInput = document.getElementById('message-input');
    if (msgInput) {
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.onclick = sendMessage;

    // Settings
    const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn');
    if (sidebarSettingsBtn) sidebarSettingsBtn.onclick = openSettings;

    // Modal Cancel
    const modalCancel = document.getElementById('modal-cancel');
    if (modalCancel) modalCancel.onclick = () => document.getElementById('modal-container').style.display = 'none';

    // Context Listeners
    document.getElementById('nav-header-settings')?.addEventListener('click', () => openServerSettings(currentContext.id));

    // Mute / Deafen
    document.getElementById('user-mute-btn')?.addEventListener('click', toggleMute);
    document.getElementById('user-deafen-btn')?.addEventListener('click', toggleDeafen);

    // Group Delete
    document.getElementById('delete-group-btn')?.addEventListener('click', () => showDeleteConfirmationModal('group', currentContext.id, currentContext.data?.name || 'this group'));

    // Header Actions
    document.getElementById('header-invite-btn')?.addEventListener('click', () => showInviteModal());
    document.getElementById('join-voice-btn')?.addEventListener('click', () => joinVoice());

    // Logout
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      fetch('/api/auth/logout', { method: 'POST' }).then(() => location.reload());
    });

    // Fullscreen button handler
    const fullscreenBtn = document.getElementById('fullscreen-call-btn');
    if (fullscreenBtn) {
      fullscreenBtn.onclick = (e) => {
        e.stopPropagation();
        window.toggleCallFullscreen();
      };
    }

    // Modal Close
    const closeSrvSettings = document.getElementById('close-server-settings');
    if (closeSrvSettings) closeSrvSettings.onclick = () => document.getElementById('server-settings-modal').style.display = 'none';

    // Settings Actions
    const settingsClose = document.getElementById('settings-close');
    if (settingsClose) settingsClose.onclick = () => document.getElementById('settings-modal').style.display = 'none';

    document.getElementById('theme-light')?.addEventListener('click', () => setTheme('light'));
    document.getElementById('theme-dark')?.addEventListener('click', () => setTheme('dark'));

    const editProfileBtn = document.getElementById('edit-profile-btn');
    if (editProfileBtn) editProfileBtn.onclick = () => {
      document.getElementById('edit-profile-form').style.display = 'block';
      editProfileBtn.style.display = 'none';
    };
    const cancelProfileEdit = document.getElementById('cancel-profile-edit');
    if (cancelProfileEdit) cancelProfileEdit.onclick = () => {
      document.getElementById('edit-profile-form').style.display = 'none';
      if (editProfileBtn) editProfileBtn.style.display = 'block';
    };

    const saveProfileBtn = document.getElementById('save-profile-btn');
    if (saveProfileBtn) saveProfileBtn.onclick = async () => {
      const bio = document.getElementById('settings-bio-input').value;
      const avatar = document.getElementById('settings-avatar-input').value;
      await api('/api/users/me', { method: 'PUT', body: { bio, avatar } });
      currentUser = await api('/api/auth/me');
      showApp();
      document.getElementById('edit-profile-form').style.display = 'none';
      if (editProfileBtn) editProfileBtn.style.display = 'block';
    };

    // Friend Tabs
    document.querySelectorAll('.tab-item').forEach(t => {
      t.onclick = () => startFriendTab(t.dataset.tab);
    });

    // Auth Toggles
    const showReg = document.getElementById('show-register');
    if (showReg) {
      console.log("Attaching show-register handler");
      showReg.onclick = (e) => {
        console.log("Show-register clicked");
        e.preventDefault();
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
      };
    }

    const showLogin = document.getElementById('show-login');
    if (showLogin) {
      console.log("Attaching show-login handler");
      showLogin.onclick = (e) => {
        console.log("Show-login clicked");
        e.preventDefault();
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('login-form').style.display = 'block';
      };
    }

    // Login/Reg details
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
      console.log("Attaching login-btn handler");
      loginBtn.onclick = async () => {
        console.log("Login button clicked");
        const u = document.getElementById('login-username').value;
        const p = document.getElementById('login-password').value;
        try {
          console.log("Attempting login for", u);
          currentUser = await api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
          console.log("Login success", currentUser);
          showApp();
        }
        catch (e) {
          console.error("Login failed", e);
          document.getElementById('login-error').textContent = e.message;
        }
      };
    }

    const registerBtn = document.getElementById('register-btn');
    if (registerBtn) {
      console.log("Attaching register-btn handler");
      registerBtn.onclick = async () => {
        console.log("Register button clicked");
        const u = document.getElementById('reg-username').value;
        const e = document.getElementById('reg-email').value;
        const p = document.getElementById('reg-password').value;
        try {
          console.log("Attempting register for", u);
          currentUser = await api('/api/auth/register', { method: 'POST', body: { username: u, email: e, password: p } });
          console.log("Register success", currentUser);
          showApp();
        }
        catch (err) {
          console.error("Register failed", err);
          document.getElementById('register-error').textContent = err.message;
        }
      };
    }

    // Create Channel Modal
    const createActionBtn = document.getElementById('create-action-btn');
    if (createActionBtn) createActionBtn.onclick = () => {
      document.getElementById('modal-container').style.display = 'flex';
      document.getElementById('modal-title').textContent = 'Create Channel';
      document.getElementById('modal-body').innerHTML = `
           <div class="form-group"><label>Channel Name</label><input id="m-name" placeholder="new-channel"></div>
           <div class="form-group"><label>Channel Type</label><select id="m-type" style="width:100%;padding:10px;background:var(--bg-input);color:white;border:none;border-radius:4px;"><option value="text"># Text Channel</option><option value="voice">🔊 Voice Channel</option></select></div>
         `;
      document.getElementById('modal-confirm').style.display = 'block';
      document.getElementById('modal-confirm').textContent = 'Create Channel';
      document.getElementById('modal-confirm').onclick = async () => {
        const n = document.getElementById('m-name').value;
        const t = document.getElementById('m-type').value;
        if (n && (currentContext.type === 'channel' || currentServerId)) {
          const srvId = currentContext.type === 'channel' ? currentContext.data.server_id : currentServerId;
          await api('/api/channels', { method: 'POST', body: { serverId: srvId, name: n, type: t } });
          loadChannels(srvId);
          document.getElementById('modal-container').style.display = 'none';
        }
      };
    };

    // Add Friend Links
    const addFriendMain = document.getElementById('add-friend-btn-main');
    if (addFriendMain) addFriendMain.onclick = showAddFriendModal;

    const navAddFriend = document.getElementById('nav-add-friend-btn');
    if (navAddFriend) navAddFriend.onclick = showAddFriendModal;

    // Add Server Trigger
    const addServerTrigger = document.getElementById('add-server-trigger');
    if (addServerTrigger) addServerTrigger.onclick = () => {
      document.getElementById('modal-container').style.display = 'flex';
      document.getElementById('modal-title').textContent = 'Add a Server';
      document.getElementById('modal-body').innerHTML = `
          <div style="display:flex;flex-direction:column;gap:16px;">
            <div style="background:var(--bg-active);padding:16px;border-radius:8px;cursor:pointer;" onclick="window.app.showCreateServerModal()">
              <h4 style="margin:0;">Create My Own</h4>
              <p style="margin:4px 0 0;font-size:0.8rem;color:var(--text-muted);">Create a space for you and your friends.</p>
            </div>
            <div style="background:var(--bg-active);padding:16px;border-radius:8px;cursor:pointer;" onclick="window.app.showJoinServerModal()">
              <h4 style="margin:0;">Join a Server</h4>
              <p style="margin:4px 0 0;font-size:0.8rem;color:var(--text-muted);">Enter an invite code to join an existing server.</p>
            </div>
          </div>
        `;
      document.getElementById('modal-confirm').style.display = 'none';
    };

    // Global Shortcuts
    document.addEventListener('keydown', (e) => {
      // Shift + X for deletion
      if (e.shiftKey && e.key.toLowerCase() === 'x') {
        const activeEl = document.activeElement;
        const isInput = activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable;
        if (isInput) return;

        if (currentContext.type === 'server' || currentContext.type === 'channel') {
          const srvId = currentContext.type === 'server' ? currentContext.id : currentServerId;
          const srvName = document.getElementById('nav-header-title')?.textContent || 'this server';
          showDeleteConfirmationModal('server', srvId, srvName);
        } else if (currentContext.type === 'group') {
          showDeleteConfirmationModal('group', currentContext.id, currentContext.data?.name || 'this group');
        }
      }

      // Shift + Y to create new channel
      if (e.shiftKey && e.key.toLowerCase() === 'y') {
        const activeEl = document.activeElement;
        const isInput = activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable;
        if (isInput) return;
        
        e.preventDefault();
        showCreateHomeChannelModal();
      }
    });

    // Create Home Channel Modal
    function showCreateHomeChannelModal() {
      document.getElementById('modal-container').style.display = 'flex';
      document.getElementById('modal-title').textContent = 'Create Channel';
      document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
          <label>Channel Name</label>
          <input id="m-channel-name" placeholder="my-channel" style="width:100%;padding:10px;background:var(--bg-input);color:var(--text-primary);border:none;border-radius:4px;">
        </div>
        <div class="form-group">
          <label>Channel Type</label>
          <div style="display:flex;gap:12px;margin-top:8px;">
            <button type="button" id="btn-text-channel" class="channel-type-btn active" style="flex:1;padding:12px;background:var(--accent);border:none;border-radius:8px;color:white;cursor:pointer;">
              <div style="font-size:1.2rem;margin-bottom:4px;">#</div>
              <div style="font-weight:600;">Text Channel</div>
              <div style="font-size:0.75rem;opacity:0.8;">Send messages</div>
            </button>
            <button type="button" id="btn-voice-channel" class="channel-type-btn" style="flex:1;padding:12px;background:var(--bg-active);border:none;border-radius:8px;color:var(--text-primary);cursor:pointer;">
              <div style="font-size:1.2rem;margin-bottom:4px;">🔊</div>
              <div style="font-weight:600;">Voice Channel</div>
              <div style="font-size:0.75rem;opacity:0.8;">Voice chat</div>
            </button>
          </div>
        </div>
      `;
      document.getElementById('modal-confirm').style.display = 'block';
      document.getElementById('modal-confirm').textContent = 'Create Channel';
      
      let selectedType = 'text';
      
      // Type selection handlers
      setTimeout(() => {
        const textBtn = document.getElementById('btn-text-channel');
        const voiceBtn = document.getElementById('btn-voice-channel');
        
        if (textBtn) {
          textBtn.onclick = () => {
            selectedType = 'text';
            textBtn.style.background = 'var(--accent)';
            textBtn.style.color = 'white';
            voiceBtn.style.background = 'var(--bg-active)';
            voiceBtn.style.color = 'var(--text-primary)';
          };
        }
        
        if (voiceBtn) {
          voiceBtn.onclick = () => {
            selectedType = 'voice';
            voiceBtn.style.background = 'var(--accent)';
            voiceBtn.style.color = 'white';
            textBtn.style.background = 'var(--bg-active)';
            textBtn.style.color = 'var(--text-primary)';
          };
        }
      }, 0);
      
      document.getElementById('modal-confirm').onclick = async () => {
        const name = document.getElementById('m-channel-name').value.trim();
        if (!name) {
          alert('Please enter a channel name');
          return;
        }
        
        try {
          const channel = await api('/api/channels', { 
            method: 'POST', 
            body: { name, type: selectedType, server_id: null } 
          });
          document.getElementById('modal-container').style.display = 'none';
          showNotification('Channel Created', `Created ${selectedType} channel "${name}"`, 'success');
          loadHomeChannels();
          
          // Auto-open the new channel
          if (selectedType === 'text') {
            openChannel(channel.id, 'channel');
          } else {
            openChannel(channel.id, 'voice');
          }
        } catch (e) {
          alert('Failed to create channel: ' + e.message);
        }
      };
    }

    // Expose to window.app
    window.app.showCreateHomeChannelModal = showCreateHomeChannelModal;
    console.log("UI handlers attached.");
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }

  console.log("OwnDC App loaded.");
})();
