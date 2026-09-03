import React, { useCallback, useEffect, useState } from 'react';

const ARCHIFY_PROJECTION_UI_EVENT = 'archify:projection-ui';

export function showArchifyProjectionPreview(detail) {
  window.dispatchEvent(new CustomEvent(ARCHIFY_PROJECTION_UI_EVENT, { detail }));
}

const shortHash = (value) => value ? String(value).replace(/^sha256:/, '').slice(0, 12) : '—';
const statusLabel = {
  applied: 'Импортировано',
  already_applied: 'Уже применено',
  stale: 'Предпросмотр устарел',
  cancelled: 'Отменено',
  failed: 'Ошибка импорта',
  unknown: 'Неизвестный результат',
};

function Receipt({ receipt, error }) {
  const status = receipt?.status || (error ? 'failed' : 'unknown');
  return (
    <div className={`projection-receipt projection-receipt-${status}`} data-testid="projection-receipt">
      <div className="projection-receipt-title">{statusLabel[status] || status}</div>
      {error ? <div className="projection-error">{error.message || String(error)}</div> : null}
      <dl className="projection-meta">
        <div><dt>Режим</dt><dd>{receipt?.mode || '—'}</dd></div>
        <div><dt>Проекция</dt><dd className="projection-mono">{shortHash(receipt?.projectionId)}</dd></div>
        <div><dt>Источник</dt><dd className="projection-mono">{shortHash(receipt?.sourceHash)}</dd></div>
        <div><dt>Снимок</dt><dd className="projection-mono">{shortHash(receipt?.projectSnapshot)}</dd></div>
      </dl>
    </div>
  );
}

export function ArchifyProjectionOverlay() {
  const [model, setModel] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const busy = busyAction !== null;
  const [terminal, setTerminal] = useState(null);

  useEffect(() => {
    const onShow = (event) => {
      if (!event.detail?.preview?.previewToken) return;
      setModel(event.detail);
      setTerminal(null);
      setBusyAction(null);
    };
    window.addEventListener(ARCHIFY_PROJECTION_UI_EVENT, onShow);
    return () => window.removeEventListener(ARCHIFY_PROJECTION_UI_EVENT, onShow);
  }, []);

  const run = useCallback(async (kind) => {
    if (!model || busy) return;
    setBusyAction(kind);
    try {
      const callback = kind === 'confirm'
        ? model.onConfirm
        : kind === 'regenerate'
          ? model.onRegenerate
          : model.onCancel;
      if (typeof callback !== 'function') throw new Error(`Действие ${kind} недоступно`);
      const result = await callback(model.preview.previewToken);
      if (!result?.ok) {
        setTerminal({ receipt: { status: 'failed' }, error: result?.error || { message: 'Неизвестная ошибка' } });
      } else if (kind === 'regenerate') {
        // onRegenerate dispatches a fresh preview event with a NEW opaque token.
        // Do not render a terminal receipt for the consumed old preview.
        return;
      } else {
        setTerminal({ receipt: result.data?.receipt || { status: kind === 'cancel' ? 'cancelled' : 'unknown' }, error: result.data?.error || null });
      }
    } catch (error) {
      setTerminal({ receipt: { status: 'failed' }, error });
    } finally {
      setBusyAction(null);
    }
  }, [model, busy]);

  useEffect(() => {
    if (!model) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || busy) return;
      if (terminal) setModel(null);
      else run('cancel');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model, terminal, busy, run]);

  if (!model) return null;
  const p = model.preview;
  const counts = p.counts || {};
  const warnings = Array.isArray(p.warnings) ? p.warnings : [];
  const deletions = Array.isArray(p.elementIdsToDelete) ? p.elementIdsToDelete.length : 0;
  const bounds = p.bounds || {};

  return (
    <div className="projection-backdrop" role="presentation">
      <section className="projection-dialog" role="dialog" aria-modal="true" aria-labelledby="projection-title" data-testid="projection-dialog">
        <header className="projection-header">
          <div>
            <div className="projection-eyebrow">ARCHIFY PREVIEW</div>
            <h2 id="projection-title">Импорт архитектуры</h2>
          </div>
          {terminal ? <button className="projection-icon-btn" onClick={() => setModel(null)} aria-label="Закрыть">×</button> : null}
        </header>

        {terminal ? <Receipt {...terminal} /> : <>
          <div className="projection-summary">
            <div><strong>{counts.components ?? 0}</strong><span>узлов</span></div>
            <div><strong>{counts.connections ?? 0}</strong><span>связей</span></div>
            <div><strong>{counts.boundaries ?? 0}</strong><span>зон</span></div>
            <div><strong>{deletions}</strong><span>будет заменено</span></div>
          </div>
          <dl className="projection-meta">
            <div><dt>Режим</dt><dd>{p.mode || 'merge'}</dd></div>
            <div><dt>Размер</dt><dd>{Math.round(bounds.width || 0)} × {Math.round(bounds.height || 0)}</dd></div>
            <div><dt>Снимок проекта</dt><dd className="projection-mono">{shortHash(p.provenance?.projectSnapshot)}</dd></div>
            <div><dt>Версия skill</dt><dd className="projection-mono">{shortHash(p.provenance?.skillHash)}</dd></div>
          </dl>
          {warnings.length ? <div className="projection-warnings"><strong>Предупреждения</strong><ul>{warnings.map((w, i) => <li key={i}>{String(w)}</li>)}</ul></div> : null}
        </>}

        <footer className="projection-actions">
          {!terminal ? <>
            <button className="projection-btn projection-btn-secondary" disabled={busy} onClick={() => run('cancel')}>Отменить</button>
            {typeof model.onRegenerate === 'function' ? <button className="projection-btn projection-btn-secondary" disabled={busy} onClick={() => run('regenerate')} title="Отменить этот preview и построить новый">{busyAction === 'regenerate' ? 'Обновляю…' : 'Обновить'}</button> : null}
            <button className="projection-btn projection-btn-primary" disabled={busy} onClick={() => run('confirm')}>{busyAction === 'confirm' ? 'Применяю…' : 'Импортировать'}</button>
          </> : <>
            {terminal.receipt?.status === 'applied' ? <button className="projection-btn projection-btn-secondary" disabled={busy} onClick={() => run('confirm')}>{busy ? 'Проверяю…' : 'Проверить повторный confirm'}</button> : null}
            <button className="projection-btn projection-btn-primary" onClick={() => setModel(null)}>Закрыть</button>
          </>}
        </footer>
      </section>
    </div>
  );
}
