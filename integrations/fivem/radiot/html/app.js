const audio = document.getElementById('radio');
const card = document.getElementById('card');
const el = (id) => document.getElementById(id);

// Each player streams the on-air file straight from storage at the station's shared position, so
// in-game listeners hear the same moment as the website. No streaming server involved.
let wantPlay = false;
let volume = 0.5;
let offset = 0; // station clock − this machine's clock, in ms
let current = null;
let switchTimer = null;
let retryTimer = null;
let hideTimer = null;
let station = null;

const serverNow = () => Date.now() + offset;
const slotOf = (id, at, media) =>
  media ? { key: id + '@' + at, startedAt: Date.parse(at), media } : null;
const level = (s) => Math.min(1, volume * Math.pow(10, (s ? s.media.gainDb : 0) / 20));
const positionOf = (s) => (s.media.cueInMs + Math.max(0, serverNow() - s.startedAt)) / 1000;

function playSlot(s) {
  current = s;
  audio.src = s.media.url + '#t=' + positionOf(s).toFixed(2);
  audio.volume = level(s);
  audio.play().catch(scheduleRetry);
}

function sync() {
  clearTimeout(switchTimer);
  if (!wantPlay || !station) return;
  const now = station.now && slotOf(station.now.trackId, station.now.startedAt, station.now.media);
  const next =
    station.next && slotOf(station.next.trackId, station.next.startsAt, station.next.media);
  // Ignore a "now" older than what we already switched to on our own at the scheduled time.
  if (now && (!current || (now.key !== current.key && now.startedAt >= current.startedAt)))
    playSlot(now);
  if (next && current && next.key !== current.key)
    switchTimer = setTimeout(() => playSlot(next), Math.max(0, next.startedAt - serverNow()));
}

function scheduleRetry() {
  if (!wantPlay || !current) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => current && playSlot(current), 2000);
}

function disconnect() {
  wantPlay = false;
  current = null;
  clearTimeout(retryTimer);
  clearTimeout(switchTimer);
  audio.pause();
  audio.removeAttribute('src');
  audio.load(); // actually stops the download so it stops using bandwidth
}

audio.addEventListener('error', scheduleRetry);

// Stay on the shared timeline: re-seek if we drift more than a second.
setInterval(() => {
  if (!wantPlay || !current || audio.paused || audio.readyState < 3) return;
  if (Math.abs(audio.currentTime - positionOf(current)) > 1)
    audio.currentTime = positionOf(current);
}, 3000);

function setStation(s) {
  station = s;
  if (s && s.serverTime) offset = Date.parse(s.serverTime) + (s.relayDelayMs || 0) - Date.now();
  sync();
}

function render() {
  const now = station && station.now;
  el('title').textContent = now ? now.title : 'Starting up…';
  const credit = now && now.requester ? 'Requested by ' + now.requester.name : '';
  el('sub').textContent =
    [now && now.artist, credit].filter(Boolean).join(' · ') || 'Station rotation';
  el('kind').textContent = now && now.kind === 'request' ? 'On request' : 'On air';
  const art = el('art');
  if (now && now.artworkUrl) art.src = now.artworkUrl;
  else art.removeAttribute('src');
  progress();
}

function progress() {
  const now = station && station.now;
  if (!now || !now.durationMs) return (el('fill').style.width = '0');
  const elapsed = serverNow() - new Date(now.startedAt).getTime();
  el('fill').style.width = Math.max(0, Math.min(100, (elapsed / now.durationMs) * 100)) + '%';
}
setInterval(progress, 1000);

function show(seconds) {
  render();
  card.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => card.classList.remove('show'), seconds * 1000);
}

window.addEventListener('message', ({ data }) => {
  if (!data || !data.type) return;
  switch (data.type) {
    case 'play':
      volume = data.volume;
      if (!wantPlay) {
        wantPlay = true;
        current = null;
      }
      setStation(data.station);
      break;
    case 'stop':
      disconnect();
      card.classList.remove('show');
      break;
    case 'volume':
      volume = data.volume;
      audio.volume = level(current);
      break;
    case 'meta':
      setStation(data.station);
      render();
      break;
    case 'now':
      setStation(data.station);
      show(data.seconds || 8);
      break;
  }
});
