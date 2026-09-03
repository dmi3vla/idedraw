// Moved verbatim out of the main.mjs scenario dispatcher (step 1). This one was
// inline in `app.whenReady` rather than a named function, which is why it never
// looked like acceptance code. It seeds a 3-node graph, optionally asks the chat
// a question, and then returns so main.mjs can take the --visual-proof shot
// (registry entry: terminal: false).

export async function run(ctx = {}) {
  const { win } = ctx;
  const { mode = 'full' } = ctx.argv || {};

  await win.webContents.executeJavaScript(`
    (async () => {
      window.__bridge__.use_command('canvas.addNodes', { nodes: [
        { id: 'A', label: 'A', x: 100, y: 140 },
        { id: 'B', label: 'B', x: 380, y: 140 },
        { id: 'C', label: 'C', x: 660, y: 140 },
      ]});
      window.__bridge__.use_command('canvas.addEdge', { fromId: 'A', toId: 'B' });
      window.__bridge__.use_command('canvas.addEdge', { fromId: 'B', toId: 'C' });
      window.__bridge__.use_command('canvas.selectElement', { id: 'B' });
    })();
  `);
  await new Promise((r) => setTimeout(r, 300));
  if (mode !== 'canvas-only') {
    await win.webContents.executeJavaScript(`
      (async () => {
        // Chat is tucked behind the Chat button in 'full' mode; open it before
        // typing so the visual proof shows the conversation, not an empty strip.
        if (typeof window.__setChatOpen__ === 'function') window.__setChatOpen__(true);
        await new Promise((r) => setTimeout(r, 200));
        const chatRoot = document.getElementById('chat-root');
        const textarea = chatRoot.querySelector('textarea');
        const sendBtn = chatRoot.querySelector('.chat-send');
        textarea.value = 'Что сейчас выделено?';
        sendBtn.click();
      })();
    `);
    await new Promise((r) => setTimeout(r, 600));
  }
}
