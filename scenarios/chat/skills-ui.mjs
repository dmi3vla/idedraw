// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// Phase 2/3 (plan S2-S3): the chat Settings overlay now has Provider | Skills
// tabs. This scenario opens the settings, switches to Skills, waits for the
// installed CLI skills to render, optionally selects the first one, and captures
// a screenshot plus a short JSON report of what the UI actually shows.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const { mode = 'full', theme = 'dark' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  const report = await win.webContents.executeJavaScript(`(async () => {
    // In full mode the chat is collapsed behind the Chat button; open it first
    // so the Settings overlay is visible in the screenshot/checks.
    if (typeof window.__setChatOpen__ === 'function') window.__setChatOpen__(true);
    await new Promise((r) => setTimeout(r, 200));
    const openSettings = () => {
      if (window.__chat__ && typeof window.__chat__.openSettings === 'function') window.__chat__.openSettings();
    };
    const clickTab = (text) => {
      const tab = Array.from(document.querySelectorAll('.chat-tab')).find((b) => b.textContent.trim() === text);
      if (tab) tab.click();
      return !!tab;
    };
    openSettings();
    await new Promise((r) => setTimeout(r, 250));
    const hasSkillsBridge = typeof window.skillsBridge !== 'undefined';
    let listError = null;
    let listCount = -1;
    if (hasSkillsBridge) {
      try {
        const lr = await window.skillsBridge.list();
        listCount = lr.ok ? (lr.data.skills || []).length : -1;
        if (!lr.ok) listError = lr.error && lr.error.message;
      } catch (e) { listError = String((e && e.message) || e); }
    }
    const tabClicked = clickTab('Skills');
    await new Promise((r) => setTimeout(r, 500));
    const rows = Array.from(document.querySelectorAll('.chat-skill-row')).map((row) => ({
      name: (row.querySelector('.chat-skill-name')?.textContent || '').replace(/\s*(Ready|Invalid|Missing|Changed|Disabled)\s*$/, ''),
      status: (row.querySelector('.chat-skill-status')?.textContent || '').trim(),
      enabled: !!row.querySelector('input[type="checkbox"]')?.checked,
      meta: (row.querySelector('.chat-skill-meta')?.textContent || '').trim(),
    }));
    const skillsTabActive = document.querySelector('.chat-tab.chat-tab-active')?.textContent.trim() === 'Skills';
    const panes = Array.from(document.querySelectorAll('.chat-pane')).map((p) => getComputedStyle(p).display);
    const d = { hasSkillsBridge, listError, listCount, tabClicked, skillsTabActive, rows, panes, settingsVisible: document.querySelector('.chat-settings')?.style.display !== 'none' };

    // Select the first row (archify) to show the details panel.
    const first = document.querySelector('.chat-skill-row');
    if (first) first.click();
    await new Promise((r) => setTimeout(r, 250));
    d.detailsTitle = document.querySelector('.chat-skills-details-title')?.textContent || null;
    d.detailsVisible = getComputedStyle(document.querySelector('.chat-skills-details')).display !== 'none';
    return d;
  })()`);

  if (visualProof) {
    await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await new Promise((r) => setTimeout(r, 300));
    mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
    const image = await win.webContents.capturePage();
    const outName = `skills-ui-${theme}.png`;
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  console.log('SKILLS-UI ' + JSON.stringify(report, null, 2));
  const ok = report.tabClicked && report.skillsTabActive && report.rows.length > 0;
  console.log(ok ? 'SKILLS-UI: ALL CHECKS PASSED' : 'SKILLS-UI: PROBLEM(S)');
  app.quit();
}
