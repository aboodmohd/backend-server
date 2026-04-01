const form = document.getElementById('player-form');
const video = document.getElementById('video');
const statusNode = document.getElementById('status');

function setStatus(message) {
  statusNode.textContent = message;
}

function buildQuery(formData) {
  const params = new URLSearchParams();

  for (const [key, value] of formData.entries()) {
    if (!value) {
      continue;
    }

    if (formData.get('mediaType') === 'movie' && (key === 'season' || key === 'episode')) {
      continue;
    }

    params.set(key, value);
  }

  return params.toString();
}

async function loadStream(event) {
  event.preventDefault();
  setStatus('Resolving stream...');

  const response = await fetch(`/api/videasy?${buildQuery(new FormData(form))}`);
  const payload = await response.json();

  if (!response.ok || !payload?.stream) {
    throw new Error(payload?.error || 'No stream found');
  }

  setStatus(`Playing ${payload.provider} ${payload.quality}`);

  if (window.Hls?.isSupported()) {
    const hls = new window.Hls();
    hls.loadSource(payload.stream);
    hls.attachMedia(video);
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = payload.stream;
    return;
  }

  throw new Error('HLS is not supported in this browser');
}

form.addEventListener('submit', (event) => {
  loadStream(event).catch((error) => {
    setStatus(error.message || 'Playback failed');
  });
});
