const query = new URLSearchParams(window.location.search);
const video = document.getElementById('video');
const backdrop = document.getElementById('backdrop');
const chipLabel = document.getElementById('chip-label');
const eyebrow = document.getElementById('eyebrow');
const headline = document.getElementById('headline');
const meta = document.getElementById('meta');
const statusLine = document.getElementById('status-line');
const heroPlay = document.getElementById('hero-play');
const togglePlay = document.getElementById('toggle-play');
const toggleMute = document.getElementById('toggle-mute');
const volume = document.getElementById('volume');
const progress = document.getElementById('progress');
const timeLabel = document.getElementById('time-label');
const serversButton = document.getElementById('servers-button');
const serverShortcut = document.getElementById('server-shortcut');
const closeDrawer = document.getElementById('close-drawer');
const drawer = document.getElementById('drawer');
const serverList = document.getElementById('server-list');
const drawerFooter = document.getElementById('drawer-footer');
const serverLabel = document.getElementById('server-label');
const fullscreenButton = document.getElementById('fullscreen-button');
const episodeButton = document.getElementById('episode-button');
const closeWindow = document.getElementById('close-window');

let hls = null;
let state = {
  tmdbId: query.get('tmdbId') || query.get('id') || '',
  mediaType: query.get('mediaType') === 'tv' ? 'tv' : 'movie',
  season: Number.parseInt(query.get('season') || query.get('s') || '1', 10) || 1,
  episode: Number.parseInt(query.get('episode') || query.get('e') || '1', 10) || 1,
  detail: null,
  servers: [],
  currentServer: query.get('server') || '',
  resolving: false,
};

function setStatus(message) {
  statusLine.textContent = message;
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function renderMeta() {
  if (!state.detail) {
    meta.innerHTML = '';
    return;
  }
  const entries = [
    state.detail.year,
    state.detail.rating ? `${state.detail.rating.toFixed(1)} ★` : '',
    Array.isArray(state.detail.genres) ? state.detail.genres.slice(0, 3).join(' • ') : '',
  ].filter(Boolean);
  meta.innerHTML = entries.map((entry) => `<span>${entry}</span>`).join('');
}

function renderHeader() {
  if (!state.detail) {
    chipLabel.textContent = 'Loading…';
    headline.textContent = 'Loading…';
    eyebrow.textContent = 'NOVA STREAM';
    return;
  }
  const title = state.detail.title || 'Unknown';
  const seasonEpisode = state.mediaType === 'tv' ? ` • S${state.season}E${state.episode}` : '';
  chipLabel.textContent = `${title}${seasonEpisode}`;
  headline.textContent = title;
  eyebrow.textContent = state.mediaType === 'tv' ? `Series • S${state.season}E${state.episode}` : 'Movie';
  renderMeta();
  episodeButton.textContent = state.mediaType === 'tv' ? `S${state.season}E${state.episode}` : 'Movie';
}

function renderBackdrop() {
  const url = state.detail?.image_url || '';
  if (url) {
    backdrop.style.backgroundImage = `url("${url}")`;
  }
}

function renderServers() {
  if (!state.servers.length) {
    serverList.innerHTML = '<div class="empty-copy">No sources available.</div>';
    drawerFooter.textContent = 'No servers loaded';
    return;
  }
  serverList.innerHTML = state.servers.map((server) => {
    const active = server.id === state.currentServer ? 'active' : '';
    return `
      <button class="server-item ${active}" data-server="${server.id}">
        <div class="server-top">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="server-accent" style="background:${server.accent};"></span>
            <span class="server-id">${server.label}</span>
          </div>
          <span class="server-desc">${server.isDefault ? 'Default' : 'Manual'}</span>
        </div>
        <div class="server-desc">${server.description}</div>
        <div class="server-url">${server.sourceUrl}</div>
      </button>
    `;
  }).join('');
  drawerFooter.textContent = `${state.servers.length} sources ready`;
}

function openDrawer(open) {
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

async function attachStream(payload) {
  destroyHls();
  const streamUrl = payload?.stream || payload?.url;
  if (!streamUrl) {
    throw new Error(payload?.error || 'No playable stream returned');
  }

  if (window.Hls?.isSupported() && /\.m3u8(\?|$)/i.test(streamUrl)) {
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
    });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    await new Promise((resolve) => {
      hls.on(window.Hls.Events.MANIFEST_PARSED, resolve);
      hls.on(window.Hls.Events.ERROR, resolve);
    });
  } else {
    video.src = streamUrl;
  }

  video.play().then(() => {
    heroPlay.style.display = 'none';
  }).catch(() => {
    heroPlay.style.display = 'inline-flex';
  });
}

async function resolveServer(serverId) {
  state.currentServer = serverId;
  renderServers();
  const server = state.servers.find((entry) => entry.id === serverId);
  serverLabel.textContent = server ? server.label : serverId;
  setStatus(`Resolving ${server ? server.label : serverId}…`);
  state.resolving = true;
  try {
    const response = await fetch('/nova/resolve-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: serverId,
        tmdbId: state.tmdbId,
        mediaType: state.mediaType,
        season: state.season,
        episode: state.episode,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || 'Source resolution failed');
    }
    await attachStream(payload);
    setStatus(`Playing from ${server ? server.label : serverId}`);
    openDrawer(false);
  } catch (error) {
    setStatus(error?.message || 'Playback failed');
    heroPlay.style.display = 'inline-flex';
  } finally {
    state.resolving = false;
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || 'Request failed');
  }
  return payload;
}

async function bootstrap() {
  if (!state.tmdbId) {
    setStatus('Missing tmdbId');
    return;
  }
  try {
    const [detail, serversPayload] = await Promise.all([
      fetchJson(`/detail?id=${encodeURIComponent(state.tmdbId)}&type=${encodeURIComponent(state.mediaType)}`),
      fetchJson(`/nova/servers?tmdbId=${encodeURIComponent(state.tmdbId)}&mediaType=${encodeURIComponent(state.mediaType)}&season=${encodeURIComponent(state.season)}&episode=${encodeURIComponent(state.episode)}`),
    ]);
    state.detail = detail;
    state.servers = serversPayload.servers || [];
    state.currentServer = state.currentServer || serversPayload.defaultServer || state.servers[0]?.id || '';
    renderHeader();
    renderBackdrop();
    renderServers();
    if (state.currentServer) {
      await resolveServer(state.currentServer);
    } else {
      setStatus('No server available');
    }
  } catch (error) {
    setStatus(error?.message || 'Player bootstrap failed');
  }
}

heroPlay.addEventListener('click', () => {
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
});

togglePlay.addEventListener('click', () => {
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
});

toggleMute.addEventListener('click', () => {
  video.muted = !video.muted;
  toggleMute.textContent = video.muted ? '🔇' : '🔊';
});

volume.addEventListener('input', () => {
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
  toggleMute.textContent = video.muted ? '🔇' : '🔊';
});

progress.addEventListener('input', () => {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    video.currentTime = (Number(progress.value) / 100) * video.duration;
  }
});

video.addEventListener('timeupdate', () => {
  const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  progress.value = duration > 0 ? String((current / duration) * 100) : '0';
});

video.addEventListener('play', () => {
  togglePlay.textContent = '❚❚';
  heroPlay.style.display = 'none';
});

video.addEventListener('pause', () => {
  togglePlay.textContent = '▶';
  if (!state.resolving) {
    heroPlay.style.display = 'inline-flex';
  }
});

video.addEventListener('loadedmetadata', () => {
  timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
});

serversButton.addEventListener('click', () => openDrawer(true));
serverShortcut.addEventListener('click', () => openDrawer(true));
closeDrawer.addEventListener('click', () => openDrawer(false));
closeWindow.addEventListener('click', () => window.close());
fullscreenButton.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
});

serverList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-server]');
  if (!button) {
    return;
  }
  resolveServer(button.dataset.server).catch(() => {});
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    openDrawer(false);
  }
  if (event.key === ' ') {
    event.preventDefault();
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }
});

bootstrap().catch(() => {});
