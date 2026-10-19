(() => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const theme = () => document.documentElement.toggleAttribute('dark', mq.matches);
  theme();
  mq.addEventListener('change', theme);

  const panel = YTCTPanel.createPanel({ kind: 'standalone' });
  document.getElementById('mount').append(panel.host);
  panel.setVideo(null);

  // Text sent from the right-click menu ("Clean & analyze this transcript")
  if (chrome.storage.session) {
    chrome.storage.session.get('pendingText', (r) => {
      if (r && r.pendingText) {
        panel.prefill(r.pendingText.text, r.pendingText.title);
        chrome.storage.session.remove('pendingText');
      }
    });
  }
})();
