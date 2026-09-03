import * as canvas from '../canvas/adapter.mjs';
import * as project from '../project/project-store.mjs';
import { ok, err, fromThrow } from './protocol-result.mjs';
import { getSelection } from './context-store.mjs';

// query({ what, ...params }) — read-only, mirrors CodeCanvas-style
// `query` tool. `what` namespaces: canvas.* (needs a mounted canvas),
// project.* (works even with no canvas open at all).
export function query(request) {
  const { what } = request || {};
  switch (what) {
    case 'canvas.scene':
      return fromThrow(() => ({ elements: canvas.getScene() }));
    case 'canvas.elementById':
      return fromThrow(() => {
        const element = canvas.getElementById(request.id);
        if (!element) throw Object.assign(new Error(`Element not found: ${request.id}`), { code: 'NOT_FOUND' });
        return { element };
      });
    case 'canvas.selection':
      return ok(getSelection());
    case 'canvas.linkStatus':
      return ok(project.getLinkStatus());
    case 'project.graph':
      return ok({ graph: project.getProjectGraph() });
    case 'project.nodeById':
      return fromThrow(() => {
        const node = project.getProjectNode(request.id);
        if (!node) throw Object.assign(new Error(`Project node not found: ${request.id}`), { code: 'NOT_FOUND' });
        return { node };
      });
    case 'project.search':
      return fromThrow(() => ({ results: project.searchProject(request.text || '') }));
    default:
      return err('UNKNOWN_QUERY', `No such query: ${what}`);
  }
}
