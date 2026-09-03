// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// Phase 2 UI: the chat panel is tucked behind a Chat toolbar button (like the
// Library panel) and closed by the ✕ in its header. This scenario drives the
// real toggle through the DOM: closed (button visible) -> open (button hidden,
// panel shown) -> click the ✕ -> closed again (button back). Captures each state
// so the cycle is provable in screenshots, not asserted from JS only.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';

export async function run(ctx = {}) {
  const { win } = ctx;
  const { mode = 'full', theme = 'dark' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });

  async function snap(name) {
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 300));
    const image = await win.webContents.capturePage();
    const outName = `chat-toggle-${name}-${theme}.png`;
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  // State 0 (before the panel is even opened): closed by default in full mode.
  const state0 = await win.webContents.executeJavaScript(`(async () => {
    const chatRoot = document.getElementById('chat-root');
    const btn = document.querySelector('.chat-toggle');
    return { chatHidden: chatRoot.style.display === 'none' || getComputedStyle(chatRoot).display === 'none', chatBtnVisible: !!btn && btn.style.display !== 'none' };
  })()`);
  await snap('closed');

  // Open the panel by clicking the Chat button.
  await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('.chat-toggle');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 150));
  })()`);
  const state1 = await win.webContents.executeJavaScript(`(async () => {
    const chatRoot = document.getElementById('chat-root');
    const btn = document.querySelector('.chat-toggle');
    const close = document.querySelector('.chat-close');
    return { chatVisible: getComputedStyle(chatRoot).display !== 'none', chatBtnHidden: !btn || btn.style.display === 'none', closeBtnPresent: !!close };
  })()`);
  await snap('open');

  // Close it by clicking the ✕ in the panel header.
  await win.webContents.executeJavaScript(`(async () => {
    const close = document.querySelector('.chat-close');
    if (close) close.click();
    await new Promise((r) => setTimeout(r, 150));
  })()`);
  const state2 = await win.webContents.executeJavaScript(`(async () => {
    const chatRoot = document.getElementById('chat-root');
    const btn = document.querySelector('.chat-toggle');
    return { chatHidden: getComputedStyle(chatRoot).display === 'none', chatBtnBack: !!btn && btn.style.display !== 'none' };
  })()`);
  await snap('reclosed');

  const ok =
    state0.chatHidden && state0.chatBtnVisible &&
    state1.chatVisible && state1.chatBtnHidden && state1.closeBtnPresent &&
    state2.chatHidden && state2.chatBtnBack;
  console.log('CHAT-TOGGLE ' + JSON.stringify({ state0, state1, state2 }, null, 2));
  console.log(ok ? 'CHAT-TOGGLE: ALL CHECKS PASSED' : 'CHAT-TOGGLE: PROBLEM(S)');
  app.quit();
}
