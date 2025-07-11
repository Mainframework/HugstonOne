// src/main.js
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');

// ─────────────────────────────────────────────────────────────────────
// NEW: helper – replace real newlines with the literal sequence \n
// llama-cli reads one line at a time; sending an actual newline submits
// the prompt.  By escaping, we preserve multi-line user text as *one*
// prompt without breaking the model’s session.
function sanitizePrompt(str) {
  return String(str).replace(/\r?\n/g, '\\n');
}

// ── Hide the default menu bar ───────────────────────────────────────
Menu.setApplicationMenu(null);

let mainWindow = null;
let llamaProc  = null;
let stdoutBuf  = '';
let loading    = false;

// Default models folder (next to project root)
let modelsDir = resolveResource('models');

/**
 * Resolve a resource in dev vs. packaged mode.
 * In packaged mode, points inside app.asar.unpacked so native EXEs and models are accessible.
 */
function resolveResource(...segments) {
  if (app.isPackaged) {
    // resourcesPath e.g. E:\hugstontwo\app\win-unpacked\resources
    // unpacked ASAR lives in resources/app.asar.unpacked
    return path.join(process.resourcesPath, 'app.asar.unpacked', ...segments);
  } else {
    // in dev, your files live under project/src/…
    return path.join(__dirname, '..', ...segments);
  }
}

/**
 * Optional GPU detection via nvidia-smi.
 */
function detectGPU() {
  return new Promise(resolve => {
    const p = spawn('nvidia-smi', ['--query-gpu=name','--format=csv,noheader']);
    let done = false;
    p.once('close', code => { if (!done) { done = true; resolve(code === 0); }});
    p.once('error',   ()   => { if (!done) { done = true; resolve(false); }});
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    autoHideMenuBar: true, // hide menu bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  if (llamaProc) llamaProc.kill('SIGINT');
});

// ─── IPC: set the models folder manually ────────────────────────────
ipcMain.handle('set-model-folder', (_e, folder) => {
  modelsDir = folder;
  return true;
});

// ─── IPC: list available models ─────────────────────────────────────
ipcMain.handle('get-models', () => {
  if (!fs.existsSync(modelsDir)) return [];
  return fs.readdirSync(modelsDir)
    .filter(f => /\.(gguf|pt|pth|ckpt|bin|json|safetensors|onnx|pb|h5|tflite|msgpack|npz|pkl)$/i.test(f));
});

// ─── IPC: choose a model file via dialog ───────────────────────────
ipcMain.handle('choose-model-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Models', extensions: ['gguf','pt','bin','safetensors','onnx','json'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  modelsDir = path.dirname(res.filePaths[0]);
  return modelsDir;
});

// ─── IPC: load/reload the model ─────────────────────────────────────
ipcMain.handle('load-model', async (_e, opts) => {
  const { model, threads, gpuLayers, ctxSize, batchSize, flashAttn, useGpu } = opts;

  if (llamaProc) {
    llamaProc.kill('SIGINT');
    llamaProc = null;
    mainWindow.webContents.send('model-unloaded');
  }

  loading = true;
  mainWindow.webContents.send('model-loading-start');

  // detect GPU if requested
  let hasGpu = false;
  if (useGpu) hasGpu = await detectGPU();
  const nGpuLayers = hasGpu ? (gpuLayers > 0 ? gpuLayers : 999) : 0;

  // build exe path and args
  const exePath   = resolveResource('runtimes', hasGpu ? 'gpu' : 'cpu', 'llama-cli.exe');
  console.log('Spawning llama-cli from:', exePath);
  const modelPath = path.join(modelsDir, model);
  const args = [
    '-m', modelPath,
    '--threads',      `${threads}`,
    '--ctx-size',     `${ctxSize}`,
    '--batch-size',   `${batchSize}`,
    '--n-predict',    `${ctxSize}`,
    '--n-gpu-layers', `${nGpuLayers}`,
  ];
  if (flashAttn) args.push('--flash-attn');

  // spawn the process
  llamaProc = spawn(exePath, args, { stdio: ['pipe','pipe','pipe'] });

  // wire up I/O back to renderer
  llamaProc.stdout.on('data', data => {
    const txt = data.toString();
    mainWindow.webContents.send('server-log', txt);

    if (loading) {
      loading = false;
      mainWindow.webContents.send('model-loading-done');
    }

    stdoutBuf += txt;
    mainWindow.webContents.send('model-chunk', txt);

    if (stdoutBuf.includes('\n>')) {
      mainWindow.webContents.send('model-reply', stdoutBuf.split('>')[0].trim());
      stdoutBuf = '';
    }
  });
  llamaProc.stderr.on('data', data => {
    mainWindow.webContents.send('server-log', data.toString());
  });
  llamaProc.on('exit', code => {
    mainWindow.webContents.send('server-log', `llama-cli exited with code ${code}\n`);
    llamaProc = null;
  });

  return { status: 'model_loaded', model };
});

// ─── IPC: send a prompt ──────────────────────────────────────────────
ipcMain.handle('send-prompt', (_e, promptRaw) => {
  if (loading)    throw new Error('Model still loading…');
  if (!llamaProc) throw new Error('No model loaded');

  stdoutBuf = '';

  // ← NEW: escape real newlines so the CLI sees one cohesive line
  const prompt = sanitizePrompt(promptRaw);

  llamaProc.stdin.write(prompt + '\n');
  return Promise.resolve();
});

// ─── IPC: cancel inference ──────────────────────────────────────────
ipcMain.handle('cancel-inference', () => {
  if (llamaProc) llamaProc.kill('SIGINT');
  mainWindow.webContents.send('inference-stopped');
});

// ─── IPC: unload the current model ───────────────────────────────────
ipcMain.handle('unload-model', () => {
  if (llamaProc) {
    llamaProc.kill('SIGINT');
    llamaProc = null;
  }
  mainWindow.webContents.send('model-unloaded');
  return { status: 'model_unloaded' };
});
