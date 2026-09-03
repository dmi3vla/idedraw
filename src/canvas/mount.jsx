import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw';
import { _bindExcalidrawAPI, _emitSelectionChange, hitTestArchifyComponentAt } from './adapter.mjs';
import { getTheme, onThemeChange } from '../theme/theme.mjs';
import { ArchifyProjectionOverlay } from './archify-projection-overlay.jsx';

function CanvasIsland() {
  const [theme, setThemeState] = useState(getTheme());
  const prevSelectionRef = useRef([]);
  const [astContextMenu, setAstContextMenu] = useState(null);
  const menuReturnFocusRef = useRef(null);
  const pointerStartRef = useRef(null);

  const openAstForHit = (hit, returnFocus = document.activeElement) => {
    if (!hit?.sourceElementId) return false;
    window.dispatchEvent(new CustomEvent('canvas:node-context', {
      detail: {
        sourceElementId: hit.sourceElementId,
        astAnchor: hit.astAnchor,
        snapshot: hit.projectSnapshot ?? null,
        returnFocus,
      },
    }));
    return true;
  };

  useEffect(() => onThemeChange(setThemeState), []);
  useEffect(() => {
    const close = () => {
      setAstContextMenu(null);
      const target = menuReturnFocusRef.current;
      menuReturnFocusRef.current = null;
      queueMicrotask(() => { if (target?.isConnected && typeof target.focus === 'function') target.focus(); });
    };
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div
      style={{ height: '100%', width: '100%' }}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return;
        pointerStartRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUpCapture={(event) => {
        if (event.button !== 0 || !pointerStartRef.current) return;
        const start = pointerStartRef.current;
        pointerStartRef.current = null;
        // A short primary click opens the component. Dragging keeps the normal
        // Excalidraw move/resize gesture and never opens the inspector.
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
        const hit = hitTestArchifyComponentAt(event.clientX, event.clientY);
        openAstForHit(hit, document.activeElement);
      }}
      onContextMenuCapture={(event) => {
        // Keep this listener on our wrapper, not on <Excalidraw>: Excalidraw
        // does not forward arbitrary React context-menu props to its canvas.
        // The capture phase runs before its native menu; non-anchor hits are
        // deliberately untouched and therefore keep the stock context menu.
        const hit = hitTestArchifyComponentAt(event.clientX, event.clientY);
        if (hit) {
          event.preventDefault();
          event.stopPropagation();
          menuReturnFocusRef.current = document.activeElement;
          setAstContextMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            detail: {
              sourceElementId: hit.sourceElementId,
              astAnchor: hit.astAnchor,
              snapshot: hit.projectSnapshot ?? null,
              returnFocus: menuReturnFocusRef.current,
            },
          });
        } else {
          setAstContextMenu(null);
        }
      }}
    >
      <Excalidraw
        theme={theme}
        excalidrawAPI={(api) => _bindExcalidrawAPI(api)}
        onChange={(elements, appState) => {
          window.dispatchEvent(new CustomEvent('canvas:change'));
          if (!elements.some((element) => !element.isDeleted)) window.dispatchEvent(new CustomEvent('canvas:cleared'));
          const ids = Object.keys(appState.selectedElementIds || {}).filter(
            (id) => appState.selectedElementIds[id]
          );
          const prev = prevSelectionRef.current;
          if (JSON.stringify(ids) !== JSON.stringify(prev)) {
            prevSelectionRef.current = ids;
            _emitSelectionChange(ids);
          }
        }}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => window.dispatchEvent(new CustomEvent('project:open-request'))}>
            Открыть проект…
          </MainMenu.Item>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
      </Excalidraw>
      {astContextMenu && (
        <div
          // The menu lives in canvas-root, OUTSIDE #ast-root, so it never saw the
          // --ast-* aliases defined on #ast-root and always painted light. It now
          // carries the Excalidraw island classes (theme--dark switches the same
          // tokens Excalidraw itself uses) plus data-theme, so "Развернуть AST"
          // follows the selected light/dark theme like the rest of the canvas UI.
          className={`ast-context-menu excalidraw-skin${theme === 'dark' ? ' theme--dark' : ''}`}
          data-theme={theme}
          role="menu"
          style={{ left: astContextMenu.clientX, top: astContextMenu.clientY }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openAstForHit({
                sourceElementId: astContextMenu.detail.sourceElementId,
                astAnchor: astContextMenu.detail.astAnchor,
                projectSnapshot: astContextMenu.detail.snapshot,
              }, astContextMenu.detail.returnFocus);
              menuReturnFocusRef.current = null;
              setAstContextMenu(null);
            }}
          >
            Развернуть AST
          </button>
        </div>
      )}
      <ArchifyProjectionOverlay />
    </div>
  );
}

// Mounts the canvas React island into `containerEl`. Returns an unmount fn.
// This is the ONLY export the rest of the app needs from the React side —
// everything else goes through adapter.mjs (vanilla).
export function mountCanvas(containerEl) {
  const root = createRoot(containerEl);
  root.render(<CanvasIsland />);
  return () => root.unmount();
}
