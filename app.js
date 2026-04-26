// FEI S3 Thermo — Web Bluetooth client
// Requires Chrome / Edge on HTTPS or http://localhost.

const GITHUB_REPO = 'Fargo-Engineering-Inc/fei-thermo-web';

const UUID = {
  DIS:        0x180a,
  DIS_MFG:    0x2a29,
  DIS_MODEL:  0x2a24,
  DIS_HW:     0x2a27,
  DIS_FW:     0x2a26,
  ESS:        0x181a,
  TEMP:       0x2a6e,
  BAT_SVC:    0x180f,
  BAT:        0x2a19,
  OTA_SVC:    '8e400001-b5a3-f393-e0a9-e50e24dcca9e',
  OTA_CTRL:   '8e400002-b5a3-f393-e0a9-e50e24dcca9e',
  OTA_DATA:   '8e400003-b5a3-f393-e0a9-e50e24dcca9e',
  OTA_STAT:   '8e400004-b5a3-f393-e0a9-e50e24dcca9e',
  TEST_SVC:   'fe100000-0001-1000-8000-00805f9b34fb',
  TEST_CTRL:  'fe100001-0001-1000-8000-00805f9b34fb',
  TEST_STAT:  'fe100002-0001-1000-8000-00805f9b34fb',
  BAT_CAL_SVC:  'fe200000-0000-1000-8000-00805f9b34fb',
  BAT_CAL_CHAR: 'fe200001-0000-1000-8000-00805f9b34fb',
  PWR_SVC:      'fe300000-0003-1000-8000-00805f9b34fb',
  PWR_CTRL:     'fe300001-0003-1000-8000-00805f9b34fb',
};

const TEST_STATE = {
  0x00: 'IDLE', 0x01: 'RUNNING', 0x02: 'PASS', 0x03: 'FAIL', 0x04: 'ABORTED',
};

const OTA_STATUS = {
  0x00: 'idle', 0x01: 'ready', 0x02: 'uploading', 0x03: 'done',
  0x10: 'error: bad magic',
  0x11: 'error: HW mismatch',
  0x12: 'error: downgrade blocked',
  0x13: 'error: size',
  0x14: 'error: CRC',
  0x15: 'error: flash write',
  0x16: 'error: bad state',
  0x17: 'error: commit',
  0x18: 'error: battery too low (charge to >20% first)',
};

const $ = (id) => document.getElementById(id);

const state = {
  device: null, server: null, ess: null, bat: null, ota: null,
  ctrl: null, dataChar: null, stat: null,
  tempChar: null, batChar: null, testCtrlChar: null, testStatChar: null,
  testDurationMin: 5, hw: null, sw: null,
  batPct: null,
  history: [],       /* { t, f } temp history */
  batHistory: [],    /* { t, pct } battery history */
  imageBytes: null, imageHeader: null,
  batCalChar: null,
  pwrCtrlChar: null,
  otaStartTime: null,
  otaTotalBytes: 0,
};

function setBadge(connected) {
  $('badge').className = connected ? 'connected' : 'disconnected';
  $('badge').textContent = connected ? 'connected' : 'disconnected';
  $('btn-disconnect').disabled = !connected;
  $('btn-connect').disabled = connected;
  updateTestButtons();
}

/* ── chart ──────────────────────────────────────────────────────────────── */
function drawChart() {
  const c = $('chart'), ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);

  const pts = state.history.slice(-240);
  if (pts.length < 2) return;

  const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
  const tRange = tMax - tMin || 1;
  const scaleX = (t) => ((t - tMin) / tRange) * (w - 24) + 10;

  /* temperature line — left y-axis */
  const fs = pts.map(p => p.f);
  const fMin = Math.min(...fs) - 1, fMax = Math.max(...fs) + 1;
  const scaleY = (v) => h - ((v - fMin) / (fMax - fMin)) * (h - 20) - 10;

  ctx.strokeStyle = '#4aa8ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = scaleX(p.t), y = scaleY(p.f);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  /* battery line — right y-axis (0–100%) */
  const batPts = state.batHistory.filter(p => p.t >= tMin);
  if (batPts.length >= 2) {
    const scaleBat = (pct) => h - (pct / 100) * (h - 20) - 10;
    ctx.strokeStyle = '#3dd598';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    batPts.forEach((p, i) => {
      const x = scaleX(p.t), y = scaleBat(p.pct);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* labels */
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#7b8593';
  ctx.textAlign = 'left';
  ctx.fillText(`${fMin.toFixed(1)}°F`, 4, h - 2);
  ctx.fillText(`${fMax.toFixed(1)}°F`, 4, 12);
  if (batPts.length >= 2) {
    ctx.fillStyle = '#3dd598';
    ctx.textAlign = 'right';
    ctx.fillText(`${batPts[batPts.length - 1].pct}%`, w - 4, 12);
    ctx.textAlign = 'left';
  }
}

/* ── BLE helpers ─────────────────────────────────────────────────────────── */
async function readString(svc, uuid) {
  try {
    const ch = await svc.getCharacteristic(uuid);
    return new TextDecoder().decode(await ch.readValue());
  } catch { return null; }
}

/* ── connect ─────────────────────────────────────────────────────────────── */
async function connect() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth not available. Use Chrome or Edge.');
    return;
  }
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'S3-Thermo' }, { namePrefix: 'FEI-Thermo' }],
    optionalServices: [UUID.DIS, UUID.ESS, UUID.BAT_SVC, UUID.OTA_SVC, UUID.TEST_SVC, UUID.BAT_CAL_SVC, UUID.PWR_SVC],
  });
  state.device = device;
  device.addEventListener('gattserverdisconnected', onDisconnect);

  const server = await device.gatt.connect();
  state.server = server;
  $('dev-name').textContent = device.name || '?';

  const dis = await server.getPrimaryService(UUID.DIS);
  state.hw = await readString(dis, UUID.DIS_HW);
  state.sw = await readString(dis, UUID.DIS_FW);
  $('dev-ver').textContent = `${state.hw || '?'} / ${state.sw || '?'}`;

  state.ess = await server.getPrimaryService(UUID.ESS);
  state.tempChar = await state.ess.getCharacteristic(UUID.TEMP);
  state.tempChar.addEventListener('characteristicvaluechanged', onTemp);
  await state.tempChar.startNotifications();

  state.bat = await server.getPrimaryService(UUID.BAT_SVC);
  state.batChar = await state.bat.getCharacteristic(UUID.BAT);
  state.batChar.addEventListener('characteristicvaluechanged', onBat);
  await state.batChar.startNotifications();
  onBat({ target: { value: await state.batChar.readValue() } });

  try {
    state.ota = await server.getPrimaryService(UUID.OTA_SVC);
    state.ctrl     = await state.ota.getCharacteristic(UUID.OTA_CTRL);
    state.dataChar = await state.ota.getCharacteristic(UUID.OTA_DATA);
    state.stat     = await state.ota.getCharacteristic(UUID.OTA_STAT);
    state.stat.addEventListener('characteristicvaluechanged', onOtaStatus);
    await state.stat.startNotifications();
  } catch (e) { console.warn('OTA service unavailable', e); }

  try {
    const batCalSvc = await server.getPrimaryService(UUID.BAT_CAL_SVC);
    state.batCalChar = await batCalSvc.getCharacteristic(UUID.BAT_CAL_CHAR);
    $('btn-calibrate').disabled = false;
  } catch {
    $('btn-calibrate').disabled = true;
  }

  try {
    const pwrSvc = await server.getPrimaryService(UUID.PWR_SVC);
    state.pwrCtrlChar = await pwrSvc.getCharacteristic(UUID.PWR_CTRL);
    $('btn-light-sleep').disabled = false;
    $('btn-deep-sleep').disabled  = false;
  } catch {
    $('btn-light-sleep').disabled = true;
    $('btn-deep-sleep').disabled  = true;
  }

  try {
    const testSvc = await server.getPrimaryService(UUID.TEST_SVC);
    state.testCtrlChar = await testSvc.getCharacteristic(UUID.TEST_CTRL);
    state.testStatChar = await testSvc.getCharacteristic(UUID.TEST_STAT);
    state.testStatChar.addEventListener('characteristicvaluechanged', onTestStatus);
    await state.testStatChar.startNotifications();
    onTestStatus({ target: { value: await state.testStatChar.readValue() } });
  } catch (e) { console.warn('Test service unavailable', e); }

  setBadge(true);
  updateUploadEnabled();
}

function onDisconnect() {
  setBadge(false);
  $('dev-ver').textContent = '— / —';
  state.testCtrlChar = null;
  state.testStatChar = null;
  state.batCalChar   = null;
  state.pwrCtrlChar  = null;
  state.batPct       = null;
  $('btn-calibrate').disabled   = true;
  $('btn-light-sleep').disabled = true;
  $('btn-deep-sleep').disabled  = true;
  updateTestButtons();
}

async function disconnect() {
  if (state.device && state.device.gatt.connected) state.device.gatt.disconnect();
}

/* ── notifications ──────────────────────────────────────────────────────── */
function onTemp(e) {
  const centi = e.target.value.getInt16(0, true);
  const f = (centi / 100) * 9 / 5 + 32;
  $('temp-f').textContent = f.toFixed(1);
  state.history.push({ t: Date.now(), f });
  if (state.history.length > 2000) state.history.shift();
  drawChart();
}

function onBat(e) {
  const pct = e.target.value.getUint8(0);
  state.batPct = pct;
  $('bat').textContent = pct + ' %';
  state.batHistory.push({ t: Date.now(), pct });
  if (state.batHistory.length > 500) state.batHistory.shift();
  updateUploadEnabled();
  drawChart();
}

function onTestStatus(e) {
  const v = e.target.value;
  if (!v || v.byteLength < 1) return;
  const stateCode = v.getUint8(0);
  const label = TEST_STATE[stateCode & 0x7f] ?? `unknown(0x${stateCode.toString(16)})`;
  $('test-state').textContent = label + ((stateCode & 0x80) ? ' [ERROR]' : '');

  if (v.byteLength >= 7) {
    const secsLeft   = v.getUint16(1, true);
    const curTenths  = v.getUint16(3, true);
    const tgtTenths  = v.getUint16(5, true);
    const mm = String(Math.floor(secsLeft / 60)).padStart(2, '0');
    const ss = String(secsLeft % 60).padStart(2, '0');
    $('test-countdown').textContent = secsLeft > 0 ? `${mm}:${ss}` : '—';
    $('test-temps').textContent =
      `${(curTenths / 10).toFixed(1)}°F / ${(tgtTenths / 10).toFixed(1)}°F`;
    const bar = $('test-progress');
    if (stateCode === 0x01) {
      const totalSecs = state.testDurationMin * 60;
      bar.style.display = 'block';
      bar.value = totalSecs > 0 ? (totalSecs - secsLeft) / totalSecs : 0;
    } else {
      bar.style.display = 'none';
    }
  }
  updateTestButtons(stateCode & 0x7f);
}

/* 5 — OTA progress % with ETA */
function onOtaStatus(e) {
  const v = e.target.value;
  const status = v.getUint8(0);
  const bytes  = v.getUint32(1, true);
  const label  = OTA_STATUS[status] ?? `unknown 0x${status.toString(16)}`;

  if (status === 0x02 && state.otaTotalBytes > 0 && state.otaStartTime) {
    const pct     = Math.min(100, Math.round(bytes / state.otaTotalBytes * 100));
    const elapsed = (Date.now() - state.otaStartTime) / 1000;
    const rate    = elapsed > 0 ? bytes / elapsed : 0;
    const etaSec  = rate > 0 ? Math.round((state.otaTotalBytes - bytes) / rate) : null;
    const eta     = etaSec !== null ? ` — ~${etaSec}s remaining` : '';
    $('fw-status').textContent = `uploading ${pct}%${eta}`;
    $('fw-progress').value = bytes / state.otaTotalBytes;
  } else {
    $('fw-status').textContent = status === 0x03 ? 'done — device rebooting…' : label;
    if (state.imageBytes && state.otaTotalBytes > 0) {
      $('fw-progress').value = bytes / state.otaTotalBytes;
    }
  }
}

/* ── test controls ──────────────────────────────────────────────────────── */
function updateTestButtons(stateCode) {
  const connected = !!(state.server && state.server.connected && state.testCtrlChar);
  const running   = stateCode === 0x01;
  const hasResult = stateCode === 0x02 || stateCode === 0x03;
  $('btn-start-test').disabled   = !connected || running || hasResult;
  $('btn-abort-test').disabled   = !connected || !running;
  $('btn-dismiss-test').disabled = !connected || !hasResult;
}

async function startTest() {
  if (!state.testCtrlChar) return;
  const durationMin  = parseInt($('test-duration').value, 10);
  const targetTenths = Math.round(parseFloat($('test-target').value) * 10);
  state.testDurationMin = durationMin;
  const buf = new Uint8Array(5);
  const dv  = new DataView(buf.buffer);
  dv.setUint8(0, 0x01);
  dv.setUint16(1, durationMin, true);
  dv.setUint16(3, targetTenths, true);
  await state.testCtrlChar.writeValue(buf);
}

async function abortTest()    { if (state.testCtrlChar) await state.testCtrlChar.writeValue(new Uint8Array([0x02])); }
async function dismissResult(){ if (state.testCtrlChar) await state.testCtrlChar.writeValue(new Uint8Array([0x03])); }

/* ── OTA ─────────────────────────────────────────────────────────────────── */
function updateUploadEnabled() {
  const rawBatLow = state.batPct !== null && state.batPct > 0 && state.batPct < 20;
  const overrideVisible = rawBatLow;
  $('bat-override-wrap').style.display = overrideVisible ? 'block' : 'none';
  if (!overrideVisible) $('bat-override').checked = false;
  const batLow = rawBatLow && !$('bat-override').checked;
  const compat = state.imageHeader ? compatCheck(state.imageHeader) : null;
  const connected = !!(state.server && state.server.connected && state.ota);
  const ok = connected && state.imageBytes && compat && compat.ok && !batLow;
  $('btn-upload').disabled = !ok;
  if (!state.imageBytes) return;
  if (rawBatLow && !$('bat-override').checked) {
    $('fw-status').textContent = `battery ${state.batPct}% — charge to >20% or check override above`;
  } else if (rawBatLow && $('bat-override').checked) {
    $('fw-status').textContent = `battery ${state.batPct}% — override active, proceed with caution`;
  } else if (!connected) {
    $('fw-status').textContent = 'image ready — connect device to upload';
  } else if (compat && !compat.ok) {
    $('fw-status').textContent = `blocked: ${compat.msg}`;
  } else if (state.batPct === 0) {
    $('fw-status').textContent = 'battery reads 0% (USB-powered?) — ready to upload';
  } else {
    $('fw-status').textContent = 'ready to upload';
  }
}

async function onFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  if (buf.byteLength < 32) { $('fw-info').textContent = 'file too small'; return; }
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.slice(0, 4)) !== 'S3TH') {
    $('fw-info').textContent = 'not an S3TH image';
    state.imageBytes = null; updateUploadEnabled(); return;
  }
  const hdr = loadImageFromBuffer(buf);
  $('fw-info').innerHTML = fwInfoHtml(hdr, file.name, null);
  updateUploadEnabled();
}

function loadImageFromBuffer(buf) {
  const dv  = new DataView(buf);
  const hdr = {
    hdrVer: dv.getUint8(4), hwMajor: dv.getUint8(5), hwMinor: dv.getUint8(6),
    flags:  dv.getUint8(7), swMajor: dv.getUint8(8), swMinor: dv.getUint8(9),
    swPatch: dv.getUint8(10), size: dv.getUint32(12, true), crc: dv.getUint32(16, true),
  };
  state.imageBytes  = buf;
  state.imageHeader = hdr;
  return hdr;
}

function compatCheck(hdr) {
  if (!hdr || !state.hw || !state.sw)
    return { ok: false, msg: 'connect device first' };
  const [dHwMaj, dHwMin] = state.hw.split('.').map(Number);
  const [dSwMaj, dSwMin, dSwPat] = state.sw.split('.').map(Number);
  if (hdr.hwMajor !== dHwMaj || hdr.hwMinor !== dHwMin)
    return { ok: false, msg: `HW mismatch: device ${dHwMaj}.${dHwMin}, image ${hdr.hwMajor}.${hdr.hwMinor}` };
  const dev = (dSwMaj << 16) | (dSwMin << 8) | dSwPat;
  const img = (hdr.swMajor << 16) | (hdr.swMinor << 8) | hdr.swPatch;
  if (img <= dev && !(hdr.flags & 0x01))
    return { ok: false, msg: `not newer (${hdr.swMajor}.${hdr.swMinor}.${hdr.swPatch} ≤ ${state.sw})` };
  return { ok: true };
}

function fwInfoHtml(hdr, name, tag) {
  const compat = compatCheck(hdr);
  const namePart = name ? `<strong>${name}</strong>${tag ? ` (${tag})` : ''}<br>` : '';
  return `${namePart}HW <code>${hdr.hwMajor}.${hdr.hwMinor}</code>
    SW <code>${hdr.swMajor}.${hdr.swMinor}.${hdr.swPatch}</code>
    &middot; ${compat.ok
      ? '<span style="color:#3dd598">compatible</span>'
      : '<span style="color:#ff5c5c">' + compat.msg + '</span>'}`;
}

/* 6 — offline detection */
async function fetchLatestFirmware() {
  const btn = $('btn-fw-latest');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    if (!navigator.onLine) throw new Error('no internet — check your network connection');

    let rel;
    try {
      const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      if (resp.status === 404) throw new Error('no firmware releases published yet');
      if (resp.status === 403) throw new Error('GitHub API rate limited — try again in a minute');
      if (!resp.ok) throw new Error(`GitHub API error ${resp.status}`);
      rel = await resp.json();
    } catch (e) {
      if (e.name === 'TypeError') throw new Error('cannot reach GitHub — check internet connection');
      throw e;
    }

    const asset = rel.assets.find(a => a.name.endsWith('.s3th'));
    if (!asset) throw new Error('no .s3th asset in latest release');

    btn.textContent = `Downloading ${asset.name}…`;
    let buf;
    try {
      /* browser_download_url goes through github.com which omits CORS headers on
         the redirect. Use the API url with Accept: octet-stream instead — api.github.com
         has proper CORS and resolves directly to the asset bytes. */
      const dr = await fetch(asset.url, { headers: { Accept: 'application/octet-stream' } });
      if (!dr.ok) throw new Error(`HTTP ${dr.status}`);
      buf = await dr.arrayBuffer();
    } catch (err) {
      console.error('asset fetch failed:', err);
      throw new Error(`download failed — ${err.message || 'check internet connection'}`);
    }

    const u8 = new Uint8Array(buf);
    if (String.fromCharCode(...u8.slice(0, 4)) !== 'S3TH') throw new Error('not an S3TH image');

    const hdr = loadImageFromBuffer(buf);
    $('fw-info').innerHTML = fwInfoHtml(hdr, asset.name, rel.tag_name);
    updateUploadEnabled();
  } catch (e) {
    $('fw-info').textContent = `Download failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download latest from GitHub';
  }
}

async function uploadImage() {
  const buf = state.imageBytes;
  if (!buf) return;
  const u8      = new Uint8Array(buf);
  const header  = u8.slice(0, 32);
  const payload = u8.slice(32);

  state.otaStartTime  = Date.now();
  state.otaTotalBytes = payload.length;

  $('fw-status').textContent = 'starting…';
  const startCmd = new Uint8Array(1 + 32);
  startCmd[0] = 0x01;
  startCmd.set(header, 1);
  await state.ctrl.writeValue(startCmd);
  await new Promise(r => setTimeout(r, 250));

  const CHUNK = 240;
  for (let off = 0; off < payload.length; off += CHUNK) {
    const slice = payload.slice(off, off + CHUNK);
    await state.dataChar.writeValue(slice);
    /* Update progress locally between status notifications */
    const pct = Math.round((off + slice.length) / payload.length * 100);
    const elapsed = (Date.now() - state.otaStartTime) / 1000;
    const rate    = elapsed > 0 ? (off + slice.length) / elapsed : 0;
    const eta     = rate > 0 ? Math.round((payload.length - off - slice.length) / rate) : null;
    $('fw-status').textContent = `uploading ${pct}%${eta !== null ? ` — ~${eta}s remaining` : ''}`;
    $('fw-progress').value = (off + slice.length) / payload.length;
  }

  await state.ctrl.writeValue(new Uint8Array([0x03]));
  $('fw-status').textContent = 'finalizing… device will reboot';
}

/* ── battery calibration ─────────────────────────────────────────────────── */
async function calibrateBattery() {
  if (!state.batCalChar) return;
  const btn = $('btn-calibrate');
  btn.disabled = true;
  btn.textContent = 'Calibrating…';
  try {
    await state.batCalChar.writeValue(new Uint8Array([0x01]));
    const val = await state.batCalChar.readValue();
    const mv  = val.getUint32(0, true);
    btn.textContent = `Calibrated (${(mv / 1000).toFixed(3)} V)`;
    setTimeout(() => { btn.textContent = 'Calibrate battery (set 100%)'; btn.disabled = false; }, 3000);
  } catch (e) {
    btn.textContent = 'Calibrate battery (set 100%)';
    btn.disabled = false;
    alert(`Calibration failed: ${e.message}`);
  }
}

async function sendSleep(cmd) {
  if (!state.pwrCtrlChar) return;
  await state.pwrCtrlChar.writeValueWithoutResponse(new Uint8Array([cmd]));
}

/* ── browser compat check ────────────────────────────────────────────────── */
if (!navigator.bluetooth) {
  $('ble-warning').style.display = 'block';
  $('btn-connect').disabled = true;
}

/* ── event listeners ─────────────────────────────────────────────────────── */
$('btn-connect').addEventListener('click',    () => connect().catch(e => alert(e.message)));
$('btn-disconnect').addEventListener('click', disconnect);
$('btn-fw-latest').addEventListener('click',  () => fetchLatestFirmware().catch(e => { $('fw-info').textContent = `Download failed: ${e.message}`; }));
$('fw-file').addEventListener('change',       onFileChosen);
$('btn-upload').addEventListener('click',     () => uploadImage().catch(e => {
  const msg = e.message?.toLowerCase().includes('gatt')
    ? 'Device disconnected during upload — reconnect and try again'
    : e.message;
  $('fw-status').textContent = `error: ${msg}`;
}));
$('btn-start-test').addEventListener('click', () => startTest().catch(e => alert(e.message)));
$('btn-abort-test').addEventListener('click', () => abortTest().catch(e => alert(e.message)));
$('btn-dismiss-test').addEventListener('click', () => dismissResult().catch(e => alert(e.message)));
$('btn-calibrate').addEventListener('click',  () => calibrateBattery().catch(e => alert(e.message)));
$('btn-light-sleep').addEventListener('click', () => sendSleep(0x01).catch(e => alert(e.message)));
$('btn-deep-sleep').addEventListener('click',  () => sendSleep(0x02).catch(e => alert(e.message)));
$('bat-override').addEventListener('change',   () => updateUploadEnabled());
