const statusEl = document.getElementById('status');

function updateStatus(message, tone = 'info') {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.style.color = tone === 'error' ? '#ff6b6b' : '#9ef7b1';
}

async function requestCamera() {
  try {
    updateStatus('Requesting camera access…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user'
      }
    });

    stream.getTracks().forEach((track) => track.stop());
    updateStatus('Camera access granted. You can close this window.', 'info');
    chrome.runtime.sendMessage({
      type: 'fingertips:consentResult',
      payload: { ok: true }
    });

    setTimeout(() => {
      window.close();
    }, 800);
  } catch (err) {
    console.error('Fingertips consent window failed to get camera', err);
    updateStatus(`Camera access failed: ${err?.message || err}`, 'error');
    chrome.runtime.sendMessage({
      type: 'fingertips:consentResult',
      payload: { ok: false, error: err?.message || String(err) }
    });
  }
}

requestCamera();
