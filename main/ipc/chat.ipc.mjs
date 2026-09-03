// chat:send / chat:toolResult. The turn state lives in the agent runtime, not
// in module-level maps.
import { ipcMain } from 'electron';
import { CHAT_SYSTEM } from '../agent/system-prompt.mjs';

export function registerChatIpc({ configStore, secretStore, agentRuntime, logger }) {
  const { log: gLog, err: gErr } = logger;

  // Stream A: a chat message arrives from the renderer with the user's text and
  // the tool list (built in the renderer from bridge.list_commands, so this main
  // process never imports the renderer-side command registry / Excalidraw).
  // The model id is taken from config-store (what the user set in the window).
  ipcMain.on('chat:send', (event, { id, text, tools, threadId }) => {
    const senderId = event.sender.id;
    // ONE chat, several histories: the renderer sends `ast:<tabId>` while the
    // operator is working inside an AST frame and 'main' otherwise. Keying the
    // conversation by sender+thread is what keeps a frame's discussion from
    // leaking into the next frame; compaction still applies per thread.
    const convKey = `${senderId}:${typeof threadId === 'string' && threadId ? threadId : 'main'}`;
    let conv = agentRuntime.chatConversations.get(convKey);
    if (!conv) {
      conv = [];
      agentRuntime.chatConversations.set(convKey, conv);
    }
    conv.push({ role: 'user', content: text });
    agentRuntime.runChatTurn(event.sender, id, conv, tools || [], configStore, secretStore);
  });

  // Renderer reports the result of a tool it executed on the canvas; resolves the
  // pending promise created in askRendererForTool so the conversation loop can
  // feed it back as a tool_result and continue.
  ipcMain.on('chat:toolResult', (event, payload) => {
    const key = `${event.sender.id}:${payload.tool_use_id}`;
    const resolver = agentRuntime.pendingToolResults.get(key);
    if (resolver) {
      agentRuntime.pendingToolResults.delete(key);
      resolver(payload);
    }
  });
}
