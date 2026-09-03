import { bridge } from '../bridge/bridge.mjs';
import { sendMessage } from './llm-client.mjs';
import modelsCatalog from './models.json';

// Theme is applied once, globally, on document.documentElement by
// renderer-entry.jsx (the composition root) — chat only consumes the
// resulting CSS custom properties via chat.css, it does not apply them
// itself. Applying the same vars redundantly on multiple elements (body,
// chat-root, canvas chrome) was the original source of a stale-paint bug
// where getComputedStyle already reported the new value but a screenshot
// still showed the old one.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Mounts the chat panel into `containerEl`. Independent: works with no
// canvas mounted at all (canvas.* commands will simply error at call time
// via NOT_MOUNTED, project.* queries work regardless).
//
// Connection config (endpoint/model/API key) is reached ONLY through
// window.configBridge (preload.cjs → IPC → main process). The key itself
// never crosses that boundary back into the renderer — only a boolean
// "key exists" status.
export function mountChat(containerEl, options = {}) {
  const { onClose } = options;
  containerEl.innerHTML = '';
  const root = el('div', 'chat-panel');
  const header = el('div', 'chat-header');
  header.appendChild(el('span', 'chat-title', 'Agent Chat'));
  const badge = el('span', 'chat-badge', `${bridge.list_commands().data.commands.length} commands`);
  header.appendChild(badge);
  const gearBtn = el('button', 'chat-gear', '⚙');
  gearBtn.title = 'Настройки подключения';
  gearBtn.setAttribute('aria-label', 'Настройки подключения');
  header.appendChild(gearBtn);
  // Close (X): collapses the panel back to the Chat toolbar button — the chat is
  // tucked behind a button like the Library panel. Wire an onClose callback from
  // the composition root (renderer-entry) so only the root decides where the
  // panel goes; the panel itself just signals the intent.
  if (typeof onClose === 'function') {
    const closeBtn = el('button', 'chat-gear chat-close', '\u2715');
    closeBtn.title = 'Свернуть чат';
    closeBtn.setAttribute('aria-label', 'Свернуть чат');
    closeBtn.addEventListener('click', onClose);
    header.appendChild(closeBtn);
  }

  const contextBar = el('div', 'chat-context');
  const messages = el('div', 'chat-messages');
  const composer = el('div', 'chat-composer');
  const input = document.createElement('textarea');
  input.placeholder = 'Команда для холста и проекта…';
  const sendBtn = el('button', 'chat-send', '\u2191');
  // Chips above the composer: [model] [enabled skills] [linked project].
  const chips = el('div', 'chat-chips');
  // Scope row: ONE chat serves every AST frame, so the frame the operator is
  // standing in has to be visible here, with a way to drop it.
  const scopeBar = el('div', 'chat-scope');

  composer.appendChild(input);
  composer.appendChild(sendBtn);
  root.appendChild(header);
  root.appendChild(contextBar);
  root.appendChild(messages);
  root.appendChild(scopeBar);
  root.appendChild(chips);
  root.appendChild(composer);
  containerEl.appendChild(root);

  // --- C5: explicit "not configured" state — never silently send requests
  // that cannot work. The stub parser still functions without config, so the
  // composer stays usable; the banner makes the situation explicit.
  const banner = el('div', 'chat-banner');
  const bannerText = el(
    'div',
    'chat-banner-text',
    'Ключ API не настроен — сейчас отвечает локальный парсер-заглушка, а не модель.'
  );
  const bannerBtn = el('button', 'chat-banner-btn', 'Настроить подключение');
  banner.appendChild(bannerText);
  banner.appendChild(bannerBtn);
  banner.style.display = 'none';
  root.insertBefore(banner, contextBar);

  async function refreshConnectionState() {
    const c = window.configBridge;
    if (!c) return; // no preload surface (e.g. unexpected environment)
    try {
      const status = await c.getKeyStatus();
      banner.style.display = status && status.hasKey ? 'none' : 'flex';
      if (status && !status.safeStorageAvailable) {
        bannerText.textContent =
          'safeStorage недоступен (нет OS-keyring) — ключ нельзя сохранить безопасно. Сохранение будет заблокировано.';
      }
    } catch {
      // status check must never break the chat itself
    }
  }

  // --- C3: settings overlay -----------------------------------------------
  const settings = el('div', 'chat-settings');
  settings.style.display = 'none';

  // Back button sits in the title row — the bottom button row can scroll out
  // of view when the form overflows, leaving no visible way out.
  const settingsTop = el('div', 'chat-settings-top');
  const backBtn = el('button', 'chat-back', '\u2190');
  backBtn.title = 'Вернуться к чату';
  backBtn.setAttribute('aria-label', 'Вернуться к чату');
  settingsTop.appendChild(backBtn);
  settingsTop.appendChild(el('div', 'chat-settings-title', 'Настройки'));

  // Tabs: Provider (existing endpoint/model/key) | Skills (local CLI skills).
  const tabBar = el('div', 'chat-settings-tabs');
  const providerTab = el('button', 'chat-tab chat-tab-active', 'Provider');
  const skillsTab = el('button', 'chat-tab', 'Skills');
  tabBar.appendChild(providerTab);
  tabBar.appendChild(skillsTab);

  // --- Provider pane (existing connection form) -----------------------------
  const providerPane = el('div', 'chat-pane');
  const rowEndpoint = el('label', 'chat-field');
  rowEndpoint.appendChild(el('span', 'chat-field-label', 'Endpoint'));
  const endpointInput = document.createElement('input');
  endpointInput.type = 'text';
  endpointInput.placeholder = 'https://api.anthropic.com/v1/messages';
  rowEndpoint.appendChild(endpointInput);

  // Catalog entries follow the same shape as the user's Zed provider settings:
  // { name, max_tokens (context window), max_output_tokens (generation cap) }.
  const rowModel = el('label', 'chat-field');
  rowModel.appendChild(el('span', 'chat-field-label', 'Модель'));
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.setAttribute('list', 'chat-models-list');
  const datalist = document.createElement('datalist');
  datalist.id = 'chat-models-list';
  for (const m of modelsCatalog.models) {
    const opt = document.createElement('option');
    opt.value = m.name;
    datalist.appendChild(opt);
  }
  modelInput.placeholder = modelsCatalog.default;
  rowModel.appendChild(modelInput);
  rowModel.appendChild(datalist);
  const modelHint = el('div', 'chat-field-hint chat-model-hint', '');
  rowModel.appendChild(modelHint);

  function findModelEntry(id) {
    const name = (id || '').trim();
    return modelsCatalog.models.find((m) => m.name === name);
  }
  function updateModelHint() {
    const entry = findModelEntry(modelInput.value);
    modelHint.textContent = entry
      ? `контекст ${entry.max_tokens} · вывод до ${entry.max_output_tokens} токенов`
      : modelInput.value.trim()
        ? 'нет в каталоге — лимиты неизвестны'
        : '';
  }
  modelInput.addEventListener('input', updateModelHint);

  const rowKey = el('label', 'chat-field');
  rowKey.appendChild(el('span', 'chat-field-label', 'API key'));
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.placeholder = 'sk-ant-…';
  rowKey.appendChild(keyInput);
  const keyHint = el('div', 'chat-field-hint', '');
  rowKey.appendChild(keyHint);

  const settingsStatus = el('div', 'chat-settings-status', '');

  const settingsButtons = el('div', 'chat-settings-buttons');
  const checkBtn = el('button', 'chat-btn chat-btn-secondary', 'Проверить соединение');
  const saveBtn = el('button', 'chat-btn chat-btn-primary', 'Сохранить');
  const cancelBtn = el('button', 'chat-btn chat-btn-secondary', 'Отмена');
  settingsButtons.appendChild(checkBtn);
  settingsButtons.appendChild(saveBtn);
  settingsButtons.appendChild(cancelBtn);

  providerPane.appendChild(rowEndpoint);
  providerPane.appendChild(rowModel);
  providerPane.appendChild(rowKey);
  providerPane.appendChild(settingsStatus);
  providerPane.appendChild(settingsButtons);

  // --- Skills pane (local CLI skills) ---------------------------------------
  const skillsPane = el('div', 'chat-pane');
  skillsPane.style.display = 'none';
  const skillsHeader = el('div', 'chat-skills-header');
  skillsHeader.appendChild(el('span', 'chat-skills-title', 'Skills'));
  const addSkillBtn = el('button', 'chat-btn chat-btn-secondary', '+ Add Skill');
  skillsHeader.appendChild(addSkillBtn);
  const skillsList = el('div', 'chat-skills-list');
  const skillsDetails = el('div', 'chat-skills-details');
  skillsDetails.style.display = 'none';
  const skillsStatus = el('div', 'chat-settings-status', '');
  skillsPane.appendChild(skillsHeader);
  skillsPane.appendChild(skillsList);
  skillsPane.appendChild(skillsDetails);
  skillsPane.appendChild(skillsStatus);

  let selectedSkillName = null;

  function setTab(which) {
    const provider = which === 'provider';
    providerTab.classList.toggle('chat-tab-active', provider);
    skillsTab.classList.toggle('chat-tab-active', !provider);
    providerPane.style.display = provider ? 'flex' : 'none';
    skillsPane.style.display = provider ? 'none' : 'flex';
  }
  providerTab.addEventListener('click', () => setTab('provider'));
  skillsTab.addEventListener('click', () => setTab('skills'));

  function statusBadge(status) {
    const map = { ready: 'Ready', invalid: 'Invalid', missing: 'Missing', changed: 'Changed', disabled: 'Disabled' };
    return map[status] || status;
  }

  async function renderSkills() {
    const s = window.skillsBridge;
    if (!s) {
      skillsStatus.textContent = 'skillsBridge недоступен — preload не загружен';
      skillsStatus.className = 'chat-settings-status chat-status-err';
      return;
    }
    skillsList.innerHTML = '';
    const res = await s.list();
    const rows = res.ok ? res.data.skills : [];
    if (!rows.length) {
      const empty = el('div', 'chat-skills-empty', 'Скиллы не найдены. Нажмите «+ Add Skill» или установите их в ~/.agents/skills.');
      skillsList.appendChild(empty);
      return;
    }
    for (const skill of rows) {
      const row = el('div', 'chat-skill-row');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!skill.enabled;
      toggle.addEventListener('change', async () => {
        await s.setEnabled(skill.name, toggle.checked);
        renderSkills();
      });
      const body = el('div', 'chat-skill-body');
      const nameLine = el('div', 'chat-skill-name', skill.name);
      const statusEl = el('span', `chat-skill-status chat-skill-status-${skill.status}`, statusBadge(skill.status));
      nameLine.appendChild(statusEl);
      body.appendChild(nameLine);
      const meta = el('div', 'chat-skill-meta', [skill.version ? `v${skill.version}` : '', skill.description].filter(Boolean).join(' · '));
      body.appendChild(meta);
      row.appendChild(toggle);
      row.appendChild(body);
      row.addEventListener('click', () => selectSkill(skill.name));
      skillsList.appendChild(row);
    }
  }

  async function selectSkill(name) {
    const s = window.skillsBridge;
    if (!s) return;
    selectedSkillName = name;
    const res = await s.get(name);
    if (!res.ok) return;
    const skill = res.data;
    skillsDetails.innerHTML = '';
    const title = el('div', 'chat-skills-details-title', skill.name);
    skillsDetails.appendChild(title);
    const rows = [
      ['Status', statusBadge(skill.status)],
      ['Version', skill.version || '—'],
      ['Path', skill.path],
      ['Hash', skill.sha256 ? skill.sha256.slice(0, 12) + '…' : '—'],
    ];
    for (const [k, v] of rows) {
      const r = el('div', 'chat-skills-detail');
      r.appendChild(el('span', 'chat-skills-detail-key', k));
      r.appendChild(el('span', 'chat-skills-detail-val', String(v)));
      skillsDetails.appendChild(r);
    }
    const enabledRow = el('label', 'chat-skills-detail chat-skills-detail-toggle');
    const enToggle = document.createElement('input');
    enToggle.type = 'checkbox';
    enToggle.checked = !!skill.enabled;
    enToggle.addEventListener('change', async () => {
      await s.setEnabled(skill.name, enToggle.checked);
      renderSkills();
      selectSkill(skill.name);
    });
    enabledRow.appendChild(enToggle);
    enabledRow.appendChild(el('span', 'chat-skills-detail-key', 'Enabled'));
    skillsDetails.appendChild(enabledRow);

    const profileRow = el('div', 'chat-skills-detail');
    profileRow.appendChild(el('span', 'chat-skills-detail-key', 'Profile'));
    const prof = skill.profile || {};
    profileRow.appendChild(el('span', 'chat-skills-detail-val', `Canvas projection · HTML ${prof.allowHtmlExport ? 'on request' : 'disabled'}`));
    skillsDetails.appendChild(profileRow);

    const actions = el('div', 'chat-skills-actions');
    const refresh = el('button', 'chat-btn chat-btn-secondary', 'Refresh');
    const accept = el('button', 'chat-btn chat-btn-primary', 'Accept new version');
    const remove = el('button', 'chat-btn chat-btn-secondary', 'Remove reference');
    refresh.addEventListener('click', async () => { await renderSkills(); await selectSkill(skill.name); });
    accept.addEventListener('click', async () => { await window.skillsBridge.read(skill.name); await selectSkill(skill.name); });
    remove.addEventListener('click', async () => { await s.remove(skill.name); skillsDetails.style.display = 'none'; renderSkills(); });
    actions.appendChild(refresh);
    actions.appendChild(accept);
    actions.appendChild(remove);
    skillsDetails.appendChild(actions);
    skillsDetails.style.display = 'flex';
  }

  addSkillBtn.addEventListener('click', async () => {
    const s = window.skillsBridge;
    if (!s) return;
    const res = await s.addDialog();
    if (res.ok) { await renderSkills(); await selectSkill(res.data.name); }
    else if (res.error && res.error.code !== 'CANCELLED') {
      skillsStatus.textContent = `Ошибка: ${res.error.message}`;
      skillsStatus.className = 'chat-settings-status chat-status-err';
    }
  });

  settings.appendChild(settingsTop);
  settings.appendChild(tabBar);
  settings.appendChild(providerPane);
  settings.appendChild(skillsPane);
  root.appendChild(settings);

  let keyIsStored = false;

  function setStatus(text, kind) {
    settingsStatus.textContent = text;
    settingsStatus.className = `chat-settings-status${kind ? ` chat-status-${kind}` : ''}`;
  }

  async function openSettings() {
    const c = window.configBridge;
    if (!c) {
      setStatus('configBridge недоступен — preload не загружен', 'err');
      settings.style.display = 'flex';
      return;
    }
    const cfg = await c.getConfig();
    endpointInput.value = cfg.endpoint || '';
    modelInput.value = cfg.model || modelsCatalog.default;
    updateModelHint();
    keyInput.value = ''; // the stored key is never rendered back
    try {
      const status = await c.getKeyStatus();
      keyIsStored = !!(status && status.hasKey);
      keyHint.textContent = keyIsStored ? 'Ключ сохранён (введите новый, чтобы заменить)' : '';
    } catch {
      keyHint.textContent = '';
    }
    setStatus('', null);
    settings.style.display = 'flex';
    // Refresh the skills list whenever settings open (may have changed on disk).
    renderSkills();
  }

  function closeSettings() {
    settings.style.display = 'none';
    renderChips();
  }

  // Collects form values; apiKey is undefined when the field is empty,
  // which for testConnection means "use the stored key".
  function formValues() {
    return {
      endpoint: endpointInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: keyInput.value ? keyInput.value : undefined,
    };
  }

  async function checkConnection() {
    const v = formValues();
    if (!/^https:\/\//.test(v.endpoint)) return setStatus('Endpoint должен начинаться с https://', 'err');
    if (!v.model) return setStatus('Укажите модель', 'err');
    if (!v.apiKey && !keyIsStored) return setStatus('Введите API key (или сохраните его ранее)', 'err');
    setStatus('Проверяю соединение…', 'muted');
    const res = await window.configBridge.testConnection({ endpoint: v.endpoint, model: v.model, apiKey: v.apiKey });
    if (res && res.ok) setStatus('Соединение работает.', 'ok');
    else setStatus(`Ошибка: ${(res && res.error) || 'неизвестная ошибка'}`, 'err');
    return res && res.ok;
  }

  async function saveSettings() {
    const v = formValues();
    if (!/^https:\/\//.test(v.endpoint)) return setStatus('Не сохранено: endpoint должен начинаться с https://', 'err');
    if (!v.model) return setStatus('Не сохранено: укажите модель', 'err');
    if (!v.apiKey && !keyIsStored) return setStatus('Не сохранено: введите API key', 'err');
    // C4: validate BEFORE saving — invalid values are shown as an error and
    // never silently persisted.
    setStatus('Проверяю перед сохранением…', 'muted');
    const res = await window.configBridge.testConnection({ endpoint: v.endpoint, model: v.model, apiKey: v.apiKey });
    if (!res || !res.ok) {
      setStatus(`Не сохранено — проверка не прошла: ${(res && res.error) || 'неизвестная ошибка'}`, 'err');
      return;
    }
    await window.configBridge.setConfig({ endpoint: v.endpoint, model: v.model });
    if (v.apiKey) {
      try {
        await window.configBridge.setKey(v.apiKey);
        keyInput.value = '';
      } catch (e) {
        setStatus(`Конфиг сохранён, но ключ сохранить не удалось: ${String(e.message || e)}`, 'err');
        return;
      }
    }
    setStatus('Сохранено. Соединение проверено.', 'ok');
    refreshConnectionState();
  }

  gearBtn.addEventListener('click', openSettings);
  bannerBtn.addEventListener('click', openSettings);
  backBtn.addEventListener('click', closeSettings);
  cancelBtn.addEventListener('click', closeSettings);
  checkBtn.addEventListener('click', checkConnection);
  saveBtn.addEventListener('click', saveSettings);

  function renderContext() {
    const sel = bridge.getSelection();
    const link = bridge.query({ what: 'canvas.linkStatus' }).data;
    contextBar.innerHTML = '';
    const selText = sel.ids.length ? `Выделено: ${sel.ids.join(', ')}` : 'Ничего не выделено';
    const linkText = link.linked ? `Связан с проектом: ${link.projectId}` : 'Холст не связан с проектом (набросок)';
    contextBar.appendChild(el('div', 'chat-context-line', selText));
    contextBar.appendChild(el('div', 'chat-context-line chat-context-muted', linkText));
  }

  // Agent chips: model · enabled skills · link state. Freed once per render so
  // toggling a skill in settings updates what is shown above the composer.
  async function renderChips() {
    chips.innerHTML = '';
    let model = null;
    try { model = (await window.configBridge?.getConfig?.())?.model || null; } catch {}
    if (model) chips.appendChild(el('span', 'chat-chip', model));
    const skills = window.skillsBridge;
    if (skills) {
      try {
        const res = await skills.list();
        const enabled = (res.ok ? res.data.skills : []).filter((s) => s.enabled && s.status === 'ready');
        for (const s of enabled) chips.appendChild(el('span', 'chat-chip chat-chip-skill', s.name));
      } catch {
        // chips must never break the composer
      }
    }
    const link = bridge.query({ what: 'canvas.linkStatus' }).data;
    chips.appendChild(el('span', 'chat-chip', link.linked ? `Project: ${link.projectId}` : 'Sketch'));
  }
  // --- Один чат + scope-чип ---------------------------------------------
  // Панель одна на всё приложение (ноль дублирования настроек), но история
  // разделена по фреймам: id треда берём из bridge (ast:<tabId>), а узлы
  // сообщений держим здесь. Поэтому переключение фрейма больше не тащит за
  // собой обсуждение предыдущего файла.
  const threadNodes = new Map(); // threadId -> Node[]
  let currentThread = bridge.activeThreadId();

  function scopeLabel(scope) {
    if (!scope) return '';
    const lines = scope.startLine
      ? (scope.endLine && scope.endLine !== scope.startLine ? `:${scope.startLine}\u2013${scope.endLine}` : `:${scope.startLine}`)
      : '';
    return `${scope.symbol ? `${scope.symbol} · ` : ''}${scope.rel}${lines}`;
  }

  function switchThread(next) {
    if (next === currentThread) return;
    threadNodes.set(currentThread, Array.from(messages.childNodes));
    messages.replaceChildren();
    currentThread = next;
    for (const node of threadNodes.get(next) || []) messages.appendChild(node);
    messages.scrollTop = messages.scrollHeight;
  }

  function renderScope(scope = bridge.getAstScope()) {
    scopeBar.replaceChildren();
    switchThread(scope ? scope.threadId : bridge.threadIdForTab(null));
    if (!scope) {
      scopeBar.appendChild(el('span', 'chat-scope-muted', 'Контекст: весь холст'));
      return;
    }
    const chip = el('button', 'chat-chip chat-chip-scope', scopeLabel(scope));
    chip.title = 'Показать это место в AST-фрейме';
    // Оператор тоже может скакнуть обратно в фрейм — канал двусторонний.
    chip.onclick = () => bridge.requestAstFocus({
      tabId: scope.tabId, rel: scope.rel, startLine: scope.startLine, endLine: scope.endLine, symbol: scope.symbol,
    });
    const drop = el('button', 'chat-scope-reset', '\u2715');
    drop.title = 'Сбросить контекст фрейма';
    drop.setAttribute('aria-label', 'Сбросить контекст фрейма');
    drop.onclick = () => bridge.clearAstScope();
    scopeBar.append(chip, drop);
  }

  renderContext();
  renderChips();
  renderScope();
  bridge.onAstScopeChange(renderScope);
  // Агент → оператор: отмечаем в переписке, куда он позвал смотреть, чтобы
  // прыжок фрейма не выглядел самопроизвольным.
  bridge.onAstFocusRequest((focus) => {
    const lines = focus.startLine
      ? `:${focus.startLine}${focus.endLine && focus.endLine !== focus.startLine ? `\u2013${focus.endLine}` : ''}`
      : '';
    messages.appendChild(el('div', 'chat-reveal', `→ агент показывает ${focus.rel}${lines}${focus.note ? ` · ${focus.note}` : ''}`));
    messages.scrollTop = messages.scrollHeight;
  });
  bridge.onContextChange(renderContext);
  refreshConnectionState();

  function appendMessage(role, text) {
    const bubble = el('div', `chat-msg chat-msg-${role}`, text);
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
  }

  // Streaming bubble: created empty, filled incrementally as deltas arrive.
  function createStreamingBubble(role) {
    const bubble = el('div', `chat-msg chat-msg-${role}`);
    messages.appendChild(bubble);
    let acc = '';
    return {
      append: (s) => {
        acc += s;
        bubble.textContent = acc;
        messages.scrollTop = messages.scrollHeight;
      },
    };
  }

  function appendToolCard(name) {
    const card = el('div', 'chat-tool chat-tool-pending');
    card.appendChild(el('span', 'chat-tool-name', name));
    card.appendChild(el('span', 'chat-tool-status', '\u21BB'));
    messages.appendChild(card);
    messages.scrollTop = messages.scrollHeight;
    return card;
  }

  function appendToolCall(name, ok) {
    const card = el('div', `chat-tool ${ok ? 'chat-tool-ok' : 'chat-tool-err'}`);
    card.appendChild(el('span', 'chat-tool-name', name));
    card.appendChild(el('span', 'chat-tool-status', ok ? '\u2713' : '\u2717'));
    messages.appendChild(card);
  }

  async function handleSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendMessage('user', text);

    const keyStatus = await (window.configBridge ? window.configBridge.getKeyStatus() : Promise.resolve(null)).catch(() => null);
    const hasKey = !!(keyStatus && keyStatus.hasKey);
    const hasBridge = typeof window.chatBridge !== 'undefined' && !!window.chatBridge;

    // Offline fallback: no API key configured yet — keep the local stub so the
    // composer is never dead, but make the situation explicit.
    if (!hasKey || !hasBridge) {
      const { text: replyText, toolCall } = await sendMessage(text);
      if (toolCall) appendToolCall(toolCall.name, toolCall.result.ok);
      appendMessage('assistant', replyText);
      return;
    }

    // Real path: stream from the model in the main process. Tools are built from
    // the bridge so the model can call canvas.* commands; the model id comes from
    // the settings window (config-store), read by the main process on each call.
    // Commands that require a skill (e.g. archify.author) are only offered when
    // that skill is enabled — capability gating at the tool surface, in addition
    // to the main-process guard in the IPC handler.
    const enabledSkills = await getEnabledSkillNames();
    const tools = bridge
      .list_commands()
      .data.commands.filter((c) => {
        if (c.notForChat) return false;
        if (c.requiresSkill && !enabledSkills.includes(c.requiresSkill)) return false;
        return true;
      })
      .map((c) => ({ name: c.name, description: c.description, input_schema: c.inputSchema }));

    // Scope передаём одной явной строкой (только границы, не тело файла):
    // модель видит, где стоит оператор, а содержимое добирает astFrame.readScope.
    const scope = bridge.getAstScope();
    const payload = scope
      ? `${text}\n\n[scope] ${scopeLabel(scope)} · frame ${scope.tabId} · связи ${scope.scopeLevel || 'own'}`
      : text;
    const bubble = createStreamingBubble('assistant');
    window.chatBridge.send(payload, {
      tools,
      // Один чат — несколько историй: main ключует диалог по sender+тред.
      threadId: currentThread,
      onText: (t) => bubble.append(t),
      onTool: (name) => appendToolCard(name),
      onDone: () => {},
    });
  }

  // Resolve the set of enabled, ready skill names for tool capability gating.
  async function getEnabledSkillNames() {
    const sb = window.skillsBridge;
    if (!sb || !sb.list) return [];
    try {
      const res = await sb.list();
      const rows = res && res.ok ? res.data : (res && res.data ? res.data : []);
      const skills = Array.isArray(rows) ? rows : (rows && rows.skills) || [];
      return skills.filter((s) => s.enabled && s.status === 'ready').map((s) => s.name);
    } catch {
      return [];
    }
  }

  sendBtn.addEventListener('click', handleSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  return {
    unmount: () => { containerEl.innerHTML = ''; },
    sendProgrammatic: handleSend,
    openSettings,
    closeSettings,
    _debugAppendUser: (t) => { input.value = t; return handleSend(); },
  };
}
