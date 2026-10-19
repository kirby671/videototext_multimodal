(() => {
  const C = globalThis.YTCT;
  const DEFAULTS = {
    apiKey: '',
    model: 'claude-opus-5-5',
    analysisLang: 'en',
    removeFillers: true,
    removeTags: true,
    autoLoad: false,
    keepYouTubePanel: false,
    focus: C.DEFAULT_FOCUS
  };
  const $ = (id) => document.getElementById(id);

  // Languages for Claude's analysis: English first, then "the video's own language", then the rest A–Z.
  (() => {
    const sel = $('analysisLang');
    const add = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.append(o);
    };
    add('en', 'English (default)');
    add('auto', 'Same language as the video');
    C.LANGUAGES.filter((c) => c !== 'en')
      .map((c) => [c, C.langName(c)])
      .sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([c, n]) => add(c, n));
  })();

  function showCache() {
    chrome.storage.local.get(null, (all) => {
      const n = Object.keys(all || {}).filter((k) => k.startsWith('cache:')).length;
      $('cacheCount').textContent = n ? n + ' transcript' + (n === 1 ? '' : 's') + ' saved.' : 'Nothing saved yet.';
      $('clearN').textContent = n + ' transcript' + (n === 1 ? '' : 's');
      $('clearCache').disabled = !n;
    });
  }

  const money = (c) =>
    c >= 1 ? '$' + c.toFixed(2) : c >= 0.01 ? '$' + c.toFixed(3) : c > 0 ? '$' + c.toFixed(4) : '$0';
  function showSpend() {
    chrome.storage.local.get(['spend'], ({ spend }) => {
      $('spendText').textContent =
        spend && spend.runs
          ? 'About ' +
            money(spend.total) +
            ' over ' +
            spend.runs +
            ' run' +
            (spend.runs === 1 ? '' : 's') +
            ' since ' +
            new Date(spend.since || Date.now()).toLocaleDateString() +
            '. Estimated from the token counts Claude reports, at Anthropic’s list prices; your exact bill is on console.anthropic.com.'
          : 'Nothing spent yet. Each run shows its cost on the card when it finishes.';
    });
  }
  showSpend();
  $('resetSpend').addEventListener('click', () => chrome.storage.local.remove('spend', showSpend));

  // No key yet: explain which features need the user's own key, and how to get one.
  let asked = false;
  function showKeyNote(hasKey) {
    if (!hasKey) asked = true;
    $('keyNote').hidden = hasKey;
    $('keyOk').hidden = !(hasKey && asked);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'apiKey' in changes) showKeyNote(!!String(changes.apiKey.newValue || '').trim());
  });

  chrome.storage.local.get(DEFAULTS, (s) => {
    $('apiKey').value = s.apiKey || '';
    showKeyNote(!!String(s.apiKey || '').trim());
    if (!String(s.apiKey || '').trim()) $('apiKey').focus();
    $('model').value = s.model;
    if (!$('model').value) $('model').value = DEFAULTS.model;
    $('analysisLang').value = s.analysisLang || 'en';
    if (!$('analysisLang').value) $('analysisLang').value = 'en';
    $('focus').value = s.focus || C.DEFAULT_FOCUS;
    ['removeFillers', 'removeTags', 'autoLoad', 'keepYouTubePanel'].forEach((k) => {
      $(k).checked = !!s[k];
    });
    showCache();
  });

  function save() {
    const data = {
      apiKey: $('apiKey').value.trim(),
      model: $('model').value,
      analysisLang: $('analysisLang').value || 'en',
      focus: $('focus').value.trim() || C.DEFAULT_FOCUS,
      removeFillers: $('removeFillers').checked,
      removeTags: $('removeTags').checked,
      autoLoad: $('autoLoad').checked,
      keepYouTubePanel: $('keepYouTubePanel').checked
    };
    if (data.apiKey && !/^sk-ant-/.test(data.apiKey)) {
      $('testMsg').textContent =
        'That doesn’t look like an Anthropic API key (they start with “sk-ant-”). Click Test to check it.';
      $('testMsg').className = 'msg err';
    } else if (/^That doesn/.test($('testMsg').textContent)) {
      $('testMsg').textContent = '';
    }
    return new Promise((resolve) =>
      chrome.storage.local.set(data, () => {
        $('saveMsg').textContent = 'Saved.';
        $('saveMsg').className = 'msg ok';
        setTimeout(() => {
          $('saveMsg').textContent = '';
        }, 2500);
        resolve();
      })
    );
  }

  $('save').addEventListener('click', save);
  $('resetFocus').addEventListener('click', () => {
    $('focus').value = C.DEFAULT_FOCUS;
  });
  $('testKey').addEventListener('click', async () => {
    await save();
    $('testMsg').textContent = 'Testing…';
    $('testMsg').className = 'msg';
    chrome.runtime.sendMessage({ type: 'testKey' }, (r) => {
      if (chrome.runtime.lastError || !r) {
        $('testMsg').textContent = 'Couldn’t run the test.';
        $('testMsg').className = 'msg err';
        return;
      }
      $('testMsg').textContent = r.ok ? 'Key works (' + r.model + ').' : 'Key test failed: ' + r.error;
      $('testMsg').className = 'msg ' + (r.ok ? 'ok' : 'err');
    });
  });
  $('openLibrary').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openLibrary' }));
  $('clearCache').addEventListener('click', () => {
    $('clearConfirm').hidden = false;
    $('clearNo').focus();
  });
  $('clearNo').addEventListener('click', () => {
    $('clearConfirm').hidden = true;
  });
  $('clearYes').addEventListener('click', () => {
    chrome.storage.local.get(null, (all) => {
      // the transcripts, plus what was built from them (trend report, company network)
      const keys = Object.keys(all || {}).filter(
        (k) => k.startsWith('cache:') || k.startsWith('net:') || k === 'trends:report'
      );
      chrome.storage.local.remove(keys, () => {
        $('clearConfirm').hidden = true;
        showCache();
      });
    });
  });
})();
