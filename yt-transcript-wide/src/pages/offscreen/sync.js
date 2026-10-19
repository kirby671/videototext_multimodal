// Runs one sync from the background (offscreen document). Offscreen pages can only use chrome.runtime,
// so reading and saving the Library goes through the background service worker.
(async () => {
  const store = {
    get: (keys) => chrome.runtime.sendMessage({ type: 'syncStore', op: 'get', keys: keys == null ? null : keys }),
    set: (obj) => chrome.runtime.sendMessage({ type: 'syncStore', op: 'set', obj })
  };
  let res;
  try {
    res = await YTCTSync.syncNow(store, { ask: false });
  } catch (e) {
    res = { ok: false, reason: 'error', error: String((e && e.message) || e) };
  }
  chrome.runtime.sendMessage({ type: 'syncDone', res });
})();
