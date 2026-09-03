// The single IPC registration point (refactor rule 3): every module gets its
// dependencies as parameters and imports nothing from main.mjs.
import { registerWindowIpc } from './window.ipc.mjs';
import { registerConfigIpc } from './config.ipc.mjs';
import { registerChatIpc } from './chat.ipc.mjs';
import { registerArchifyIpc } from './archify.ipc.mjs';
import { registerProjectIpc } from './project.ipc.mjs';
import { registerAstIpc } from './ast.ipc.mjs';
import { registerEditorIpc } from './editor.ipc.mjs';
import { registerSkillIpc } from './skills.ipc.mjs';

export function registerAllIpc(deps) {
  registerWindowIpc(deps);
  registerConfigIpc(deps);
  registerChatIpc(deps);
  registerArchifyIpc(deps);
  registerProjectIpc(deps);
  registerAstIpc(deps);
  registerEditorIpc(deps);
  registerSkillIpc(deps);
}
