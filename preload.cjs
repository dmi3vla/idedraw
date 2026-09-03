// Preload: the ONLY surface through which the renderer reaches chat
// connection config and the API key. Following the same principle as
// bridge.mjs on the renderer side: a narrow, named, reviewable API.
//
// The API key itself NEVER crosses this boundary. The renderer gets:
//  - config get/set (endpoint + model)
//  - a boolean key status (does a key exist, is safeStorage available)
//  - the result of a connection test performed in the main process
//  - setKey/clearKey for the settings form

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('configBridge', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getKeyStatus: () => ipcRenderer.invoke('secret:keyStatus'),
  setKey: (plain) => ipcRenderer.invoke('secret:setKey', plain),
  clearKey: () => ipcRenderer.invoke('secret:clearKey'),
  // { endpoint?, model?, apiKey? } — omitted apiKey means "test the stored one".
  testConnection: (input) => ipcRenderer.invoke('config:testConnection', input),
});

// Archify import surface (Phase 2). The renderer asks the main process to run
// the archify CLI against a spec path and returns the resolved IR. The renderer
// then converts + commits that IR through the existing bridge command, so the
// actual subprocess stays in main.
contextBridge.exposeInMainWorld('archifyBridge', {
  validate: (specPath) => ipcRenderer.invoke('archify:validate', { specPath }),
  generateProject: (input) => ipcRenderer.invoke('archify:generateProject', input || {}),
  cancelGeneration: () => ipcRenderer.invoke('archify:cancelGeneration'),
  onGenerationProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('archify:generationProgress', listener);
    return () => ipcRenderer.removeListener('archify:generationProgress', listener);
  },
  author: (input) => ipcRenderer.invoke('archify:author', input),
  readSkillFile: (input) => ipcRenderer.invoke('archify:readSkillFile', input || {}),
});

// Read-only project tools (plan S4.1 security closure). The renderer asks the
// main process to list/read/search the user-chosen project so the agent can
// gather evidence for an archify candidate. Every call is confined to the
// MAIN-OWNED root; the renderer never passes a path and nothing can write into
// the project. `chooseDirectory` opens a native dir picker (the only way a
// project becomes linked); `setRoot` exists for the acceptance harness only.
contextBridge.exposeInMainWorld('projectBridge', {
  chooseDirectory: () => ipcRenderer.invoke('project:chooseDirectory'),
  saveCanvas: (input) => ipcRenderer.invoke('project:saveCanvas', input || {}),
  queueAutosave: (input) => ipcRenderer.invoke('project:queueAutosave', input || {}),
  flushAutosave: () => ipcRenderer.invoke('project:flushAutosave'),
  getStatus: () => ipcRenderer.invoke('project:status'),
  clear: () => ipcRenderer.invoke('project:clear'),
  listFiles: () => ipcRenderer.invoke('project:listFiles'),
  readFile: (input) => ipcRenderer.invoke('project:readFile', input || {}),
  expandAstAnchor: (input) => ipcRenderer.invoke('project:expandAstAnchor', input || {}),
  readAstPreview: (input) => ipcRenderer.invoke('project:readAstPreview', input || {}),
  writeAstFile: (input) => ipcRenderer.invoke('project:writeAstFile', input || {}),
  search: (input) => ipcRenderer.invoke('project:search', input || {}),
  getSnapshot: () => ipcRenderer.invoke('project:snapshot'),
});

// Skills surface (plan slice S2). The renderer lists/disables/removes local CLI
// skills and opens a native folder-picker to add one. The SKILL.md body is read
// on demand for the agent-runtime prompt builder; it is never a free file read.
contextBridge.exposeInMainWorld('skillsBridge', {
  list: () => ipcRenderer.invoke('skills:list'),
  get: (name) => ipcRenderer.invoke('skills:get', { name }),
  read: (name) => ipcRenderer.invoke('skills:read', { name }),
  addDialog: () => ipcRenderer.invoke('skills:addDialog'),
  setEnabled: (name, enabled) => ipcRenderer.invoke('skills:setEnabled', { name, enabled }),
  remove: (name) => ipcRenderer.invoke('skills:remove', { name }),
});

// Frameless window controls (frame: false in main.mjs): fire-and-forget
// messages; the main process resolves the sending window from the event.
contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
  close: () => ipcRenderer.send('window:close'),
});

// Chat streaming surface (plan stream A). The renderer sends one message at a
// time; the main process streams back `chat:stream` events. Tool execution is
// requested back via `chat:toolRequest` and answered with `chat:toolResult`.
let chatSeq = 0;
contextBridge.exposeInMainWorld('chatBridge', {
  send: (text, opts) => {
    const id = ++chatSeq;
    const handlers = opts || {};
    const onStream = (event, data) => {
      if (data.id !== id) return;
      if (data.type === 'text') handlers.onText && handlers.onText(data.text);
      else if (data.type === 'tool') handlers.onTool && handlers.onTool(data.name);
      else if (data.type === 'done') {
        ipcRenderer.removeListener('chat:stream', onStream);
        handlers.onDone && handlers.onDone(data.error);
      }
    };
    ipcRenderer.on('chat:stream', onStream);
    // threadId lets ONE chat keep separate histories (one per AST frame), so
    // switching frames does not drag the previous file's discussion along.
    ipcRenderer.send('chat:send', { id, text, tools: handlers.tools, threadId: handlers.threadId || 'main' });
    return () => ipcRenderer.removeListener('chat:stream', onStream);
  },
  onToolRequest: (cb) => {
    const handler = (event, req) => {
      cb(req, (result) =>
        ipcRenderer.send('chat:toolResult', {
          tool_use_id: req.tool_use_id,
          ok: !!(result && result.ok),
          data: result && result.data,
          error: result && result.error,
        })
      );
    };
    ipcRenderer.on('chat:toolRequest', handler);
    return () => ipcRenderer.removeListener('chat:toolRequest', handler);
  },
  // One receipt per chat turn, sent by the main process when the turn context is
  // frozen. Carries only stable public identity: model, enabled skill id+sha256,
  // the main-owned allowlist, project linked flag + snapshot hash. NO SKILL.md
  // content, NO binary/candidate paths, NO API keys, NO absolute project paths.
  onRunReceipt: (cb) => {
    const handler = (event, data) => cb(data);
    ipcRenderer.on('chat:runReceipt', handler);
    return () => ipcRenderer.removeListener('chat:runReceipt', handler);
  },
});
