// options.js — PKRelay settings page logic

const $ = (sel) => document.querySelector(sel);

async function load() {
  const stored = await chrome.storage.local.get(['browserName', 'relayPort', 'relayToken', 'isDefault', 'knownBrowsers']);
  $('#browserName').value = stored.browserName || '';
  $('#relayPort').value = stored.relayPort || 18792;
  $('#relayToken').value = stored.relayToken || '';
  $('#isDefault').checked = !!stored.isDefault;
  $('#knownBrowsers').value = (stored.knownBrowsers || []).join(', ');
}

async function save() {
  const browserName = $('#browserName').value.trim();
  const relayPort = parseInt($('#relayPort').value, 10);
  const relayToken = $('#relayToken').value.trim();
  const isDefault = $('#isDefault').checked;
  const knownBrowsers = $('#knownBrowsers').value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!relayPort || relayPort < 1 || relayPort > 65535) {
    showStatus('error', 'Port must be 1-65535');
    return;
  }

  await chrome.storage.local.set({
    browserName: browserName || 'Browser',
    relayPort,
    relayToken,
    isDefault,
    knownBrowsers
  });

  showToast('Saved');
}

async function testConnection() {
  const port = parseInt($('#relayPort').value, 10) || 18792;
  showStatus('checking', 'Checking...');

  try {
    const url = `http://127.0.0.1:${port}/`;
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000)
    });
    if (resp.ok || resp.status < 500) {
      showStatus('ok', `Connected (port ${port})`);
    } else {
      showStatus('error', `Server error: ${resp.status}`);
    }
  } catch (err) {
    showStatus('error', `Cannot reach port ${port}`);
  }
}

function showStatus(type, text) {
  const el = $('#healthStatus');
  el.className = `status ${type}`;
  el.innerHTML = `<span class="status-dot"></span>${text}`;
}

function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

$('#saveBtn').addEventListener('click', async () => {
  await save();
  await testConnection();
});

$('#testBtn').addEventListener('click', testConnection);

load();

// Test native messaging host availability
try {
  chrome.runtime.sendNativeMessage('com.pkrelay.token_reader', { action: 'getConfig' }, (resp) => {
    const el = $('#tokenAutoStatus');
    if (chrome.runtime.lastError) {
      el.textContent = 'Native host not installed. Run ./install.sh to enable auto-read.';
      el.style.color = '#666';
    } else if (resp?.token) {
      el.textContent = 'Auto-read from ~/.openclaw/openclaw.json (native host active)';
      el.style.color = '#22C55E';
    } else if (resp?.error) {
      el.textContent = 'Native host error: ' + resp.error;
      el.style.color = '#EF4444';
    }
  });
} catch {}
