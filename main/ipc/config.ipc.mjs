// Config + secret storage IPC — AND ONLY THIS. The chat and archify-generation
// handlers that used to live here now have their own modules.
import { ipcMain } from 'electron';
import { validateConfigPatch } from '../config-store.mjs';
import { sendTestRequest } from '../anthropic-client.mjs';

export function registerConfigIpc({ configStore, secretStore }) {
  ipcMain.handle('config:get', () => configStore.load());

  ipcMain.handle('config:set', (event, patch) => {
    const check = validateConfigPatch(patch);
    if (!check.ok) throw Object.assign(new Error(check.error), { code: 'BAD_INPUT' });
    return configStore.save(patch || {});
  });

  ipcMain.handle('secret:keyStatus', () => ({
    hasKey: secretStore.hasKey(),
    safeStorageAvailable: secretStore.isAvailable(),
  }));

  ipcMain.handle('secret:setKey', (event, plain) => {
    secretStore.setKey(plain);
    return { ok: true };
  });

  ipcMain.handle('secret:clearKey', () => {
    secretStore.clearKey();
    return { ok: true };
  });

  ipcMain.handle('config:testConnection', async (event, input) => {
    const cfg = configStore.load();
    const apiKey = (input && input.apiKey) || secretStore.getKey();
    return sendTestRequest({
      endpoint: (input && input.endpoint) || cfg.endpoint,
      model: (input && input.model) || cfg.model,
      apiKey,
    });
  });
}
