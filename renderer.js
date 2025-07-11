// src/renderer/renderer.js

window.addEventListener('DOMContentLoaded', () => {
  /* ─────────────────────────── MONOSPACE FONT INJECTION (emoji-aware) ─────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    /* ---------------- monospace + word-wrap (unchanged) */
    .message.bot.markdown pre,
    .message.bot.markdown pre code {
      font-family: var(--ff-mono);
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .message.bot.markdown pre {
      width: 100%;
      box-sizing: border-box;
      position: relative;
    }
    .message.bot.markdown .copy-btn {
      position: sticky;
      top: 10px;
      float: right;
      z-index: 10;
    }

    /* ------------- thinking bubble style ------------- */
    .message.bot.markdown.thinking {
      border: 2px dashed #999;
      border-radius: 1em;
      padding: 1em;
      background-color: #fafafa;
      position: relative;
    }
    /* little “thought” tail (CSS-only) */
    .message.bot.markdown.thinking::after {
      content: "";
      position: absolute;
      bottom: -12px;      /* tail below box */
      left: 20px;         /* adjust horizontally */
      width: 16px;
      height: 12px;
      background: #fafafa;
      border-right: 2px dashed #999;
      border-bottom: 2px dashed #999;
      transform: rotate(45deg);
    }
  `;
  document.head.appendChild(style);

  /* ─────────────────────────── DOM REFERENCES ─────────────────────────── */
  const $ = id => document.getElementById(id);

  const refs = {
    toggleSidebarBtn: $('toggleSidebar'),
    sidebar: $('sidebar'),
    chooseBtn: $('chooseLlmBtn'),
    modelSelect: $('modelSelect'),
    loadBtn: $('loadModelBtn'),
    unloadBtn: $('unloadModelBtn'),
    sessionsList: $('sessionsList'),
    newSessionBtn: $('newSession'),
    deleteSessionBtn: $('deleteSession'),
    chatWindow: $('chatWindow'),
    previewDiv: $('previewContainer'),
    previewFrame: $('previewFrame'),
    togglePrevBtn: $('togglePreviewBtn'),
    promptInput: $('promptInput'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    toggleTermBtn: $('toggleTerminalBtn'),
    terminal: $('terminal'),
    loadProgress: $('loadProgress'),
    loadPct: $('loadPct'),
    modelStatus: $('modelStatus'),
    threadsInput: $('threadsInput'),
    gpuLayersInput: $('gpuLayersInput'),
    ctxSizeInput: $('ctxSizeInput'),
    batchSizeInput: $('batchSizeInput'),
    flashAttnCheck: $('flashAttnCheckbox'),
    useGpuCheck: $('useGpuCheckbox'),
    // new file-upload refs
    fileInput: $('fileInput'),
    uploadFilesBtn: $('uploadFilesBtn'),
  };

  // Verify all elements exist
  for (const [name, el] of Object.entries(refs)) {
    if (!el) {
      console.error(`Missing DOM element: ${name}`);
      return;
    }
  }

  /* ─────────────────────────── STATE & CONSTANTS ─────────────────────────── */
  const STORAGE_KEY = 'hugston-sessions';
  let currentSession = null;
  let buffering = '';
  let isPending = false;
  let loadInterval = null;

  // Always show preview pane
  refs.previewDiv.classList.remove('hidden');

  /* ─────────────────────────── PERSIST SELECTED MODEL ─────────────────────────── */
  // Save whenever user picks a model
  refs.modelSelect.addEventListener('change', () => {
    localStorage.setItem('selectedModel', refs.modelSelect.value);
  });

  /* ─────────────────────────── UTILITY FUNCTIONS ─────────────────────────── */
  const isAtBottom = (el, tol = 50) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= tol;

  /* ─────────────────────────── PREVIEW CONTROLS ─────────────────────────── */
  refs.togglePrevBtn.addEventListener('click', () => {
    const fs = $('main').classList.toggle('preview-fullscreen');
    refs.togglePrevBtn.textContent = fs ? 'Restore Preview' : 'Expand Preview';
  });

  /* ─────────────────────────── PREVIEW IFRAME SETUP ─────────────────────────── */
  const preview = {
    init() {
      try {
        const doc = refs.previewFrame.contentDocument;
        doc.open();
        doc.write(`<!doctype html>
<html><head>
  <meta charset="utf-8">
  <style>
    html,body {
      margin:0;
      padding:0;
      font-family:"Noto Sans Variable","Noto Color Emoji",sans-serif;
    }
  </style>
  <script src="libs/d3/d3.min.js"></script>
  <script src="libs/chart/Chart.min.js"></script>
  <script src="libs/plotly/plotly.min.js"></script>
  <script src="libs/google-charts/loader.js"></script>
  <script src="libs/mermaid/mermaid.min.js"></script>
  <script>if(window.mermaid)mermaid.initialize({startOnLoad:true});</script>
</head><body></body></html>`);
        doc.close();
      } catch (e) {
        console.error('preview.init error:', e);
      }
    },
    clear() {
      try {
        refs.previewFrame.contentDocument.body.innerHTML = '';
      } catch (e) {
        console.error('preview.clear error:', e);
      }
    }
  };
  preview.init();

  /* ─────────────────────────── SETTINGS PERSISTENCE ─────────────────────────── */
  const SETTINGS = [
    refs.threadsInput,
    refs.gpuLayersInput,
    refs.ctxSizeInput,
    refs.batchSizeInput
  ];
  const CHECKS = [refs.flashAttnCheck, refs.useGpuCheck];

  SETTINGS.forEach(el =>
    el.addEventListener('change', () => localStorage.setItem(el.id, el.value))
  );
  CHECKS.forEach(el =>
    el.addEventListener('change', () =>
      localStorage.setItem(el.id, JSON.stringify(el.checked))
    )
  );

  SETTINGS.forEach(el => {
    const val = localStorage.getItem(el.id);
    if (val !== null) el.value = val;
  });
  CHECKS.forEach(el => {
    const val = localStorage.getItem(el.id);
    if (val !== null) el.checked = JSON.parse(val);
  });

  /* ─────────────────────────── MODEL FOLDER & LIST ─────────────────────────── */
  async function refreshModels() {
    try {
      const list = await window.hugston.getModels();
      refs.modelSelect.innerHTML = list.length
        ? list.map(m => `<option>${m}</option>`).join('')
        : '<option disabled>(no models)</option>';
      refs.modelSelect.disabled = refs.loadBtn.disabled = !list.length;

      // Restore previous model if still available
      const saved = localStorage.getItem('selectedModel');
      if (saved && list.includes(saved)) {
        refs.modelSelect.value = saved;
      }
    } catch (e) {
      console.error('Error refreshing models:', e);
      refs.modelSelect.innerHTML = '<option disabled>(error)</option>';
    }
  }

  (async () => {
    const dir = localStorage.getItem('modelsDir');
    if (dir) {
      try {
        await window.hugston.setModelFolder(dir);
      } catch (e) {
        console.error('Error setting model folder:', e);
      }
    }
    await refreshModels();
  })();

  refs.chooseBtn.addEventListener('click', async () => {
    try {
      const dir = await window.hugston.chooseModelFolder();
      if (!dir) return;
      localStorage.setItem('modelsDir', dir);
      await window.hugston.setModelFolder(dir);
      await refreshModels();
    } catch (e) {
      console.error('Error choosing model folder:', e);
    }
  });

  /* ─────────────────────────── SESSION MANAGEMENT ─────────────────────────── */
  function loadSessions() {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    refs.sessionsList.innerHTML = '';
    Object.keys(all).forEach(name => {
      const li = document.createElement('li');
      li.textContent = name;
      li.classList.toggle('active', name === currentSession);
      li.onclick = () => selectSession(name);
      refs.sessionsList.appendChild(li);
    });
    refs.deleteSessionBtn.disabled = !currentSession;
  }

  function saveSession() {
    if (!currentSession) return;
    const msgs = Array.from(refs.chatWindow.children)
      .filter(c => c.classList.contains('message'))
      .map(c => ({
        role: c.classList.contains('bot') ? 'bot' : 'user',
        text: c.innerText
      }));
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    all[currentSession] = msgs;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function selectSession(name) {
    saveSession();
    currentSession = name;
    refs.chatWindow.innerHTML = '';
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')[name] || [];
    data.forEach(({ role, text }) => {
      const d = document.createElement('div');
      d.className = `message ${role}${role === 'bot' ? ' markdown' : ''}`;
      d.innerText = text;
      refs.chatWindow.appendChild(d);
    });
    refs.chatWindow.scrollTop = refs.chatWindow.scrollHeight;
    loadSessions();
  }

  refs.newSessionBtn.addEventListener('click', () => {
    saveSession();
    currentSession = null;
    refs.chatWindow.innerHTML = '';
    loadSessions();
  });

  refs.deleteSessionBtn.addEventListener('click', () => {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    delete all[currentSession];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    currentSession = null;
    refs.chatWindow.innerHTML = '';
    loadSessions();
  });

  loadSessions();

  /* ─────────────────────────── MODEL LOAD / UNLOAD ─────────────────────────── */
  refs.loadBtn.addEventListener('click', async () => {
    if (!refs.modelSelect.value) {
      return alert('Please select a model first.');
    }
    refs.sendBtn.disabled = true;
    refs.terminal.textContent = '';
    preview.clear();
    buffering = '';
    refs.loadBtn.disabled = true;
    refs.unloadBtn.disabled = false;
    try {
      await window.hugston.loadModel({
        model: refs.modelSelect.value,
        threads: +refs.threadsInput.value,
        gpuLayers: +refs.gpuLayersInput.value,
        ctxSize: +refs.ctxSizeInput.value,
        batchSize: +refs.batchSizeInput.value,
        flashAttn: refs.flashAttnCheck.checked,
        useGpu: refs.useGpuCheck.checked
      });
    } catch (e) {
      console.error('Error loading model:', e);
      alert(`Error loading model: ${e.message}`);
    }
  });

  refs.unloadBtn.addEventListener('click', () => {
    try {
      window.hugston.unloadModel();
    } catch (e) {
      console.error('Error unloading model:', e);
    }
  });

  /* ─────────────────────────── CHAT & STREAMING ─────────────────────────── */
  function appendUserMessage(txt) {
    const d = document.createElement('div');
    d.className = 'message user';
    d.innerText = txt;
    refs.chatWindow.appendChild(d);
  }

  function appendBotBubble() {
    const d = document.createElement('div');
    // add the "thinking" flag immediately
    d.className = 'message bot markdown thinking';
    refs.chatWindow.appendChild(d);
    return d;
  }

  function doSend() {
    const txt = refs.promptInput.value.trim();
    if (!txt || isPending) return;
    if (!currentSession) {
      currentSession = txt.split(/\s+/).slice(0, 4).join(' ');
    }
    saveSession();
    appendUserMessage(txt);
    refs.chatWindow.scrollTop = refs.chatWindow.scrollHeight;
    refs.promptInput.value = '';
    appendBotBubble();
    buffering = '';
    isPending = true;
    refs.sendBtn.disabled = true;
    refs.stopBtn.disabled = false;
    preview.clear();
    window.hugston.sendPrompt(txt).catch(err => {
      const bots = refs.chatWindow.querySelectorAll('.message.bot.markdown');
      if (bots.length) bots[bots.length - 1].innerText = `Error: ${err.message}`;
      isPending = false;
      refs.sendBtn.disabled = false;
    });
  }

  refs.sendBtn.addEventListener('click', doSend);
  refs.promptInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  refs.stopBtn.addEventListener('click', () => {
    try {
      window.hugston.cancelInference();
    } catch (e) {
      console.error('Error stopping inference:', e);
    }
  });

  refs.toggleTermBtn.addEventListener('click', () => {
    refs.terminal.classList.toggle('hidden');
  });

  /* ─────────────────────────── FILE UPLOAD LOGIC ─────────────────────────── */
  refs.uploadFilesBtn.addEventListener('click', () => {
    refs.fileInput.click();
  });
  refs.fileInput.addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (file.size > 100 * 1024 * 1024) {
        alert(`${file.name} is too large (>100 MB), skipping.`);
        continue;
      }
      try {
        const text = await file.text();
        appendUserMessage(`[File: ${file.name}]\n${text}`);
        window.hugston.sendPrompt(`[File: ${file.name}]\n${text}`);
      } catch (err) {
        console.error('Error reading file', file.name, err);
        alert(`Failed to read ${file.name}`);
      }
    }
    refs.fileInput.value = '';
  });

  window.hugston.onLog(msg => {
    refs.terminal.textContent += msg;
    refs.terminal.scrollTop = refs.terminal.scrollHeight;
  });

  window.hugston.onModelChunk(chunk => {
    buffering += chunk;
    const bots = refs.chatWindow.querySelectorAll('.message.bot.markdown');
    if (!bots.length) return;
    const last = bots[bots.length - 1];
    try {
      last.innerHTML = marked.parse(buffering);
    } catch {
      last.innerText = buffering;
    }
    if (isAtBottom(refs.chatWindow)) {
      refs.chatWindow.scrollTop = refs.chatWindow.scrollHeight;
    }
  });

  /* ─────────────────────────── LOADING BAR EVENTS ─────────────────────────── */
  window.hugston.onLoadingStart(() => {
    clearInterval(loadInterval);
    refs.loadProgress.value = 0;
    refs.loadPct.textContent = '0%';
    refs.modelStatus.textContent = 'Loading…';
    loadInterval = setInterval(() => {
      if (refs.loadProgress.value < 98) {
        refs.loadProgress.value++;
        refs.loadPct.textContent = `${refs.loadProgress.value}%`;
      }
    }, 100);
  });

  window.hugston.onLoadingDone(() => {
    clearInterval(loadInterval);
    refs.loadProgress.value = 100;
    refs.loadPct.textContent = '100%';
    refs.modelStatus.textContent = `Loaded ${refs.modelSelect.value}`;
    refs.sendBtn.disabled = false;
  });

  window.hugston.onModelUnloaded(() => {
    clearInterval(loadInterval);
    refs.loadProgress.value = 0;
    refs.loadPct.textContent = '0%';
    refs.modelStatus.textContent = 'idle';
    refs.sendBtn.disabled = true;
    refs.loadBtn.disabled = false;
    refs.unloadBtn.disabled = true;
  });

  /* ─────────────────────────── FINAL REPLY / PREVIEW ─────────────────────────── */
  window.hugston.onModelReply(() => {
    isPending = false;
    refs.sendBtn.disabled = false;
    refs.stopBtn.disabled = true;

    const bots = refs.chatWindow.querySelectorAll('.message.bot.markdown');
    if (!bots.length) return;
    const last = bots[bots.length - 1];

    // 1) drop the "thinking" style
    last.classList.remove('thinking');

    // 2) render the final markdown
    try {
      last.innerHTML = marked.parse(buffering);
    } catch {
      last.innerText = buffering;
    }

    // 3) rebuild the preview iframe
    preview.clear();
    const doc = refs.previewFrame.contentDocument;
    let handled = false;

    // -- iframe[srcdoc]
    last.querySelectorAll('iframe[srcdoc]').forEach(el => {
      doc.open();
      doc.write(el.srcdoc);
      doc.close();
      handled = true;
    });

    // -- inline SVG
    if (!handled) {
      const svgs = last.querySelectorAll('svg');
      if (svgs.length) {
        svgs.forEach(svg => doc.body.appendChild(svg.cloneNode(true)));
        handled = true;
      }
    }

    // -- HTML code blocks
    if (!handled) {
      last.querySelectorAll('pre code').forEach(code => {
        const txt = code.innerText.trim();
        if (/^<!doctype/i.test(txt) || /^<html/i.test(txt)) {
          doc.open();
          doc.write(txt);
          doc.close();
          handled = true;
        } else if (txt.startsWith('<') && txt.includes('>')) {
          doc.body.innerHTML = txt;
          handled = true;
        }
      });
    }

    // -- fallback rich elements
    if (!handled) {
      ['table','img','video','audio','object','embed','canvas'].forEach(tag => {
        last.querySelectorAll(tag).forEach(el =>
          doc.body.appendChild(el.cloneNode(true))
        );
      });
    }

    // 4) ensure download-preview button exists
    if (!refs.previewDiv.querySelector('.dl-btn')) {
      const dl = document.createElement('button');
      dl.textContent = 'Download Preview';
      dl.className = 'preview-toggle dl-btn';
      dl.onclick = () => {
        const html = refs.previewFrame.contentDocument.documentElement.outerHTML;
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'preview.html'; a.click();
        URL.revokeObjectURL(url);
      };
      refs.previewDiv.appendChild(dl);
    }

    // 5) re-attach copy buttons
    last.querySelectorAll('pre code').forEach(code => {
      if (window.hljs) hljs.highlightElement(code);
      const btn = document.createElement('button');
      btn.textContent = 'Copy';
      btn.className = 'copy-btn';
      btn.onclick = () => {
        navigator.clipboard.writeText(code.innerText)
          .then(() => {
            btn.textContent = '✓';
            setTimeout(() => btn.textContent = 'Copy', 1200);
          })
          .catch(e => console.error('Copy failed:', e));
      };
      const pre = code.closest('pre');
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });

    saveSession();
  });

  /* ─────────────────────────── INFERENCE STOPPED ─────────────────────────── */
  window.hugston.onInferenceStopped(() => {
    refs.terminal.textContent += '[Inference stopped]\n';
    isPending = false;
    refs.sendBtn.disabled = false;
    refs.stopBtn.disabled = true;
  });
});
