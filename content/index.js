(async () => {
  try {
    await import(chrome.runtime.getURL('content/main.js'));
  } catch (err) {
    console.error('Fingertips: failed to initialize content scripts', err);
  }
})();
