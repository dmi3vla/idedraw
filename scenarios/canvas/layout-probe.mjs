// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// Layout probe (edit-time tool, not a phase proof): dumps the live bounding
// rects of the top-right controls (Excalidraw's Library / menu islands), the
// window controls cluster, the top-left toolbar, the chat root and the Chat
// button, so the Chat button can be moved to a position that does not overlap
// the Library button or the window controls. Finds the Library button by text
// match, then falls back to Excalidraw's top-right island classes.

import { app } from 'electron';

export async function run(ctx = {}) {
  const { win } = ctx;
  const rects = await win.webContents.executeJavaScript(`(async () => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
    const out = { buttons: [] };

    // Every visible <button>'s text + aria/title + rect, so Library is located
    // by content or accessible label (icon-only buttons expose the label there).
    document.querySelectorAll('button').forEach((b) => {
      const txt = (b.textContent || '').trim();
      const style = getComputedStyle(b);
      if (style.display !== 'none' && style.visibility !== 'hidden' && b.offsetParent !== null) {
        out.buttons.push({ text: txt.slice(0, 40), aria: (b.getAttribute('aria-label') || '').slice(0, 40), title: (b.title || '').slice(0, 40), rect: r(b) });
      }
    });

    // Children of the Excalidraw top-right island, annotated (Library button).
    out.topRight = [];
    document.querySelectorAll('.layer-ui__wrapper__top-right *').forEach((b) => {
      const ownTag = b.tagName.toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').slice(0, 40);
      const title = (b.title || '').slice(0, 40);
      if (ownTag === 'button' || ownTag === 'a' || aria || title) {
        if (b.offsetParent !== null) {
          out.topRight.push({ tag: ownTag, cls: (b.className || '').toString().slice(0, 60), text: (b.textContent || '').trim().slice(0, 30), aria, title, rect: r(b) });
        }
      }
    });

    // Any island descendants, plain (so we can see a help/other button to the left).
    out.topRightAll = [];
    document.querySelectorAll('.layer-ui__wrapper__top-right').forEach((el) => {
      out.topRightAll.push({ cls: (el.className || '').toString().slice(0, 80), rect: r(el) });
      el.querySelectorAll('button, label').forEach((b) => {
        out.topRightAll.push({ tag: b.tagName.toLowerCase(), cls: (b.className || '').toString().slice(0, 60), text: (b.textContent || '').trim().slice(0, 20), aria: (b.getAttribute('aria-label') || '').slice(0, 30), rect: r(b) });
      });
    });

    // Try known Excalidraw top-right island selectors too, in case the Library
    // / menu buttons have no visible text.
    out.islands = [];
    document.querySelectorAll('[class*="top__right"], [class*="Island"], [class*="main-menu"], .excalidraw .layer-ui__wrapper__top-right').forEach((el) => {
      if (el.offsetParent !== null) out.islands.push({ cls: (el.className || '').toString().slice(0, 80), rect: r(el) });
    });

    out.windowControls = r(document.querySelector('.window-controls'));
    out.toolbar = r(document.querySelector('.toolbar')) || r(document.getElementById('toolbar'));
    const chatBtn = document.querySelector('.chat-toggle') || Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Chat');
    out.chatButton = r(chatBtn);
    out.chatToggle = r(document.querySelector('.chat-toggle'));
    out.toolbarButtons = [];
    document.querySelectorAll('.toolbar button, #toolbar button').forEach((b) => out.toolbarButtons.push({ text: (b.textContent || '').trim(), rect: r(b) }));
    out.chatRoot = r(document.getElementById('chat-root'));
    const chatR = document.getElementById('chat-root');
    out.chatRootRect = chatR ? { display: getComputedStyle(chatR).display, rect: r(chatR) } : null;
    out.bodySize = { w: document.body.clientWidth, h: document.body.clientHeight };
    return out;
  })()`);
  console.log('LAYOUT-PROBE ' + JSON.stringify(rects, null, 2));
  app.quit();
}
