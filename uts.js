// FEI Thermo — UTS (Unit Test Sequence) wizard
// Chrome / Edge only (Web Bluetooth). Three steps: Install → Connect → Running → Result.
//
// ── PROTOCOL FLOW ───────────────────────────────────────────────────────────
//
// Service: FEI Test Service  fe100000-0001-1000-8000-00805f9b34fb
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Step 1 — INSTALL (no BLE)                                               │
// │   User confirms unit is plugged into charge bulkhead and mounted in cab.│
// │   No BLE messages.                                                      │
// └─────────────────────────────────────────────────────────────────────────┘
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Step 2 — CONNECT + BATTERY CHECK                                        │
// │                                                                         │
// │  ble.requestDevice(filters: FEI Thermo / FEI-Thermo)                   │
// │  ble.connect()                                                          │
// │                                                                         │
// │  READ  DIS 0x180A / HW Revision  0x2A27  → string e.g. "2.0"           │
// │  READ  DIS 0x180A / FW Revision  0x2A26  → string e.g. "1.2.87"        │
// │  READ  Battery 0x180F / Level 0x2A19     → uint8  battery %            │
// │  START NOTIFY Battery 0x2A19                                            │
// │  START NOTIFY TEST_STAT fe100002-...                                    │
// │  READ  TEST_STAT  (get current state in case test already running)      │
// │                                                                         │
// │  Battery gate: if 0 < pct < 20 → block start, show warning.            │
// │  Battery = 0 is treated as USB-powered — test allowed.                  │
// └─────────────────────────────────────────────────────────────────────────┘
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Step 3 — START TEST                                                     │
// │                                                                         │
// │  WRITE TEST_CTRL  fe100001-...  (5 bytes, little-endian)                │
// │    [0]    op         = 0x01  (START)                                    │
// │    [1-2]  duration   = 0x0F 0x00  (15 min LE)                          │
// │    [3-4]  tgt_tenths = 0x4A 0x01  (330 = 33.0 °F LE)                  │
// └─────────────────────────────────────────────────────────────────────────┘
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Step 4 — RUNNING (device sends TEST_STAT every 1 s)                     │
// │                                                                         │
// │  NOTIFY TEST_STAT  fe100002-...  (7 bytes, little-endian)               │
// │    [0]    state      uint8   1 = RUNNING                                │
// │    [1-2]  secs_left  uint16  seconds remaining (countdown)             │
// │    [3-4]  cur_tenths int16   current temp × 10  in °F                  │
// │    [5-6]  tgt_tenths int16   target  temp × 10  in °F  (330 = 33.0°F) │
// │                                                                         │
// │  Watchdog: if no STAT notification for 35 s → declare FAIL             │
// │                                                                         │
// │  ABORT (optional):                                                      │
// │    WRITE TEST_CTRL  [0x02]  → device posts ABORTED, stops timer        │
// └─────────────────────────────────────────────────────────────────────────┘
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Step 5 — RESULT                                                         │
// │                                                                         │
// │  Device sends final STAT notification on expiry:                        │
// │    state = 0x02  PASS  if cur_tenths ≤ tgt_tenths (temp cooled enough) │
// │    state = 0x03  FAIL  if cur_tenths  > tgt_tenths                     │
// │                                                                         │
// │  UI shows verdict, reason string (temps), final cur_tenths value.      │
// │                                                                         │
// │  DISMISS (resets device to IDLE):                                       │
// │    WRITE TEST_CTRL  [0x03]  → device state → IDLE                      │
// └─────────────────────────────────────────────────────────────────────────┘
//
// TEST_STATE codes:  0x00 IDLE  0x01 RUNNING  0x02 PASS  0x03 FAIL  0x04 ABORTED
// ────────────────────────────────────────────────────────────────────────────

const UUID = {
  DIS:        0x180a,
  DIS_MODEL:  0x2a24,
  DIS_HW:     0x2a27,
  DIS_FW:     0x2a26,
  ESS:        0x181a,
  TEMP:       0x2a6e,
  BAT_SVC:    0x180f,
  BAT:        0x2a19,
  TEST_SVC:   'fe100000-0001-1000-8000-00805f9b34fb',
  TEST_CTRL:  'fe100001-0001-1000-8000-00805f9b34fb',  // WRITE: start/abort/dismiss
  TEST_STAT:  'fe100002-0001-1000-8000-00805f9b34fb',  // READ + NOTIFY: 7-byte status
};

// Fixed test parameters for UTS
const TEST_TARGET_F    = 33.0;            // °F
const TEST_DURATION_M  = 15;             // minutes
const TEST_TARGET_TENTHS = Math.round(TEST_TARGET_F * 10);  // 330

// If we receive no STAT notification for this many ms while RUNNING, declare FAIL
const NO_RESPONSE_TIMEOUT_MS = 35_000;

const $ = (id) => document.getElementById(id);

const uts = {
  device:       null,
  server:       null,
  testCtrl:     null,
  testStat:     null,
  batChar:      null,
  batPct:       null,
  hw:           null,
  sw:           null,
  lastStatMs:   null,   // timestamp of last TEST_STAT notification
  watchdogTimer: null,
};

// ── wizard navigation ────────────────────────────────────────────────────────

const STEPS = ['step-install', 'step-connect', 'step-running', 'step-result'];

function showStep(id) {
  STEPS.forEach(s => { $(s).style.display = s === id ? 'block' : 'none'; });
}

// ── BLE helpers ──────────────────────────────────────────────────────────────

async function readString(svc, uuid) {
  try {
    const ch = await svc.getCharacteristic(uuid);
    return new TextDecoder().decode(await ch.readValue());
  } catch { return null; }
}

// ── connect ──────────────────────────────────────────────────────────────────

async function bleConnect() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'FEI Thermo' }, { namePrefix: 'FEI-Thermo' }],
    optionalServices: [UUID.DIS, UUID.ESS, UUID.BAT_SVC, UUID.TEST_SVC],
  });
  uts.device = device;
  device.addEventListener('gattserverdisconnected', onBleDisconnect);

  uts.server = await device.gatt.connect();

  // DIS
  const dis = await uts.server.getPrimaryService(UUID.DIS);
  uts.hw = await readString(dis, UUID.DIS_HW);
  uts.sw = await readString(dis, UUID.DIS_FW);
  $('connect-dev').textContent = device.name || '?';
  $('connect-fw').textContent  = `HW ${uts.hw || '?'} / FW ${uts.sw || '?'}`;

  // Battery
  const batSvc  = await uts.server.getPrimaryService(UUID.BAT_SVC);
  uts.batChar   = await batSvc.getCharacteristic(UUID.BAT);
  uts.batChar.addEventListener('characteristicvaluechanged', onBat);
  await uts.batChar.startNotifications();
  onBat({ target: { value: await uts.batChar.readValue() } });

  // Test service
  const testSvc  = await uts.server.getPrimaryService(UUID.TEST_SVC);
  uts.testCtrl   = await testSvc.getCharacteristic(UUID.TEST_CTRL);
  uts.testStat   = await testSvc.getCharacteristic(UUID.TEST_STAT);
  uts.testStat.addEventListener('characteristicvaluechanged', onTestStat);
  await uts.testStat.startNotifications();
  // Read current state in case a test is already running
  onTestStat({ target: { value: await uts.testStat.readValue() } });

  $('uts-badge').className   = 'connected';
  $('uts-badge').textContent = 'connected';
  updateStartButton();
}

function onBleDisconnect() {
  $('uts-badge').className   = 'disconnected';
  $('uts-badge').textContent = 'disconnected';
  uts.testCtrl = null;
  uts.testStat = null;
  uts.batChar  = null;
  clearWatchdog();

  // If we were mid-test, record as FAIL due to connection loss
  const step = STEPS.find(s => $(s).style.display !== 'none');
  if (step === 'step-running') {
    showResult('FAIL', 'Connection lost during test', uts.lastCurF ?? null);
  }
}

// ── battery notification ──────────────────────────────────────────────────────

function onBat(e) {
  const pct = e.target.value.getUint8(0);
  uts.batPct = pct;

  $('connect-bat').textContent = pct + ' %';
  $('run-bat').textContent     = pct + ' %';

  const warn = $('uts-bat-warn');
  if (pct > 0 && pct < 20) {
    $('uts-bat-pct').textContent = pct;
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
  updateStartButton();
}

function updateStartButton() {
  const connected = !!(uts.server && uts.server.connected && uts.testCtrl);
  const batOk     = uts.batPct === null || uts.batPct === 0 || uts.batPct >= 20;
  $('btn-start-uts-test').disabled = !connected || !batOk;
}

// ── TEST_STAT packet decoder ─────────────────────────────────────────────────
//
// STAT packet (7 bytes, little-endian):
//   [0]     state     uint8   0=IDLE 1=RUNNING 2=PASS 3=FAIL 4=ABORTED
//   [1-2]   secs_left uint16  seconds remaining (0 when not running)
//   [3-4]   cur_tenths int16  current temp × 10 in °F
//   [5-6]   tgt_tenths int16  target temp × 10 in °F

function onTestStat(e) {
  const v = e.target.value;
  if (!v || v.byteLength < 1) return;

  uts.lastStatMs = Date.now();
  resetWatchdog();

  const stateCode = v.getUint8(0);

  if (v.byteLength < 7) return;
  const secsLeft  = v.getUint16(1, true);
  const curTenths = v.getInt16(3, true);
  const tgtTenths = v.getInt16(5, true);

  const curF = curTenths / 10;
  const tgtF = tgtTenths / 10;
  uts.lastCurF = curF;

  switch (stateCode) {
    case 0x01: // RUNNING
      showStep('step-running');
      updateRunningUI(secsLeft, curF);
      break;

    case 0x02: // PASS
      clearWatchdog();
      showResult('PASS', `${curF.toFixed(1)} °F ≤ ${tgtF.toFixed(1)} °F at expiry`, curF);
      break;

    case 0x03: // FAIL
      clearWatchdog();
      showResult('FAIL', `${curF.toFixed(1)} °F > ${tgtF.toFixed(1)} °F at expiry`, curF);
      break;

    case 0x04: // ABORTED
      clearWatchdog();
      showResult('FAIL', 'Test was aborted', curF);
      break;

    // IDLE — no action, stay on connect step
  }
}

// ── running UI ───────────────────────────────────────────────────────────────

function updateRunningUI(secsLeft, curF) {
  const mm  = String(Math.floor(secsLeft / 60)).padStart(2, '0');
  const ss  = String(secsLeft % 60).padStart(2, '0');
  $('run-countdown').textContent = `${mm}:${ss}`;
  $('run-cur-temp').textContent  = `${curF.toFixed(1)} °F`;

  const totalSecs = TEST_DURATION_M * 60;
  $('run-progress').value = totalSecs > 0 ? (totalSecs - secsLeft) / totalSecs : 0;
}

// ── watchdog — no-response → FAIL ────────────────────────────────────────────

function resetWatchdog() {
  clearWatchdog();
  uts.watchdogTimer = setTimeout(() => {
    showResult('FAIL', 'No response from device (connection lost?)', uts.lastCurF ?? null);
  }, NO_RESPONSE_TIMEOUT_MS);
}

function clearWatchdog() {
  if (uts.watchdogTimer) { clearTimeout(uts.watchdogTimer); uts.watchdogTimer = null; }
}

// ── result ───────────────────────────────────────────────────────────────────

function showResult(verdict, reason, finalTempF) {
  showStep('step-result');
  $('result-title').textContent   = verdict === 'PASS' ? 'Test passed' : 'Test failed';
  $('result-verdict').textContent = verdict;
  $('result-verdict').className   = `verdict ${verdict.toLowerCase()}`;
  $('result-reason').textContent  = reason;
  $('result-temp').textContent    = finalTempF !== null ? `${finalTempF.toFixed(1)} °F` : '—';
}

// ── BLE test commands ─────────────────────────────────────────────────────────

// START command: op(1) + duration_min(2 LE) + target_tenths_F(2 LE)
async function sendStart() {
  const buf = new Uint8Array(5);
  const dv  = new DataView(buf.buffer);
  dv.setUint8(0,  0x01);
  dv.setUint16(1, TEST_DURATION_M,    true);   // e.g. 15
  dv.setUint16(3, TEST_TARGET_TENTHS, true);   // e.g. 330 (33.0°F)
  await uts.testCtrl.writeValue(buf);
}

// ABORT command: op(1) = 0x02
async function sendAbort() {
  await uts.testCtrl.writeValue(new Uint8Array([0x02]));
}

// DISMISS command: op(1) = 0x03  — clears PASS/FAIL back to IDLE on device
async function sendDismiss() {
  await uts.testCtrl.writeValue(new Uint8Array([0x03]));
}

// ── event listeners ───────────────────────────────────────────────────────────

$('btn-install-confirm').addEventListener('click', () => showStep('step-connect'));

$('btn-uts-connect').addEventListener('click', () =>
  bleConnect().catch(e => alert(`Connect failed: ${e.message}`)));

$('btn-start-uts-test').addEventListener('click', () =>
  sendStart().catch(e => alert(`Start failed: ${e.message}`)));

$('btn-abort-uts').addEventListener('click', () =>
  sendAbort()
    .then(() => { clearWatchdog(); showStep('step-connect'); })
    .catch(e => alert(`Abort failed: ${e.message}`)));

$('btn-result-dismiss').addEventListener('click', () => {
  sendDismiss().catch(() => {});   // best-effort; device may have already reset
  showStep('step-connect');
  updateStartButton();
});

$('btn-result-restart').addEventListener('click', () => {
  sendDismiss().catch(() => {});
  showStep('step-connect');
  updateStartButton();
});

// ── boot ────────────────────────────────────────────────────────────────────

if (!navigator.bluetooth) {
  $('uts-ble-warn').style.display = 'block';
}

showStep('step-install');
