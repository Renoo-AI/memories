import { getPowHeader } from "./pow-solver.js";
import { cleanToken } from "./token-utils.js";

const WEB_BASE = "https://chat.deepseek.com/api/v0";

// Memory cache for web chat sessions mapped by local session ID
const webSessionCache = new Map();

export async function ensureWebSession(rawToken, localSessionId) {
  const dsToken = cleanToken(rawToken);
  if (!dsToken) {
    throw new Error("No DeepSeek session token configured.");
  }

  if (localSessionId && webSessionCache.has(localSessionId)) {
    return webSessionCache.get(localSessionId);
  }

  const storage =
    (typeof browser !== "undefined" && browser?.storage?.local)
      ? browser.storage.local
      : (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : null);

  // Check persistent storage if available
  if (storage && localSessionId) {
    const key = `web_ds_session_${localSessionId}`;
    const stored = await storage.get(key);
    if (stored[key]) {
      webSessionCache.set(localSessionId, stored[key]);
      return stored[key];
    }
  }

  const headers = {
    "Content-Type": "application/json",
    "X-App-Version": "20241129.1",
    "Authorization": `Bearer ${dsToken}`,
  };

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${WEB_BASE}/chat_session/create`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      if (resp.status === 401 || resp.status === 403) {
        if (localSessionId) {
          webSessionCache.delete(localSessionId);
          if (storage) {
            await storage.remove(`web_ds_session_${localSessionId}`).catch(() => {});
          }
        }
        throw new Error(
          "DeepSeek web session rejected your token (invalid or expired). Please check your token in Settings or use an API key."
        );
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }

      const data = await resp.json();
      if (data?.code === 40003 || data?.msg?.includes("Authorization Failed") || data?.code !== 0) {
        if (localSessionId) {
          webSessionCache.delete(localSessionId);
          if (storage) {
            await storage.remove(`web_ds_session_${localSessionId}`).catch(() => {});
          }
        }
        throw new Error(
          `DeepSeek authorization failed: ${data?.msg || "invalid or expired token"}. Please check your token in Settings or use an API key.`
        );
      }

      const newSessionId = data?.data?.biz_data?.id;
      if (!newSessionId) {
        throw new Error(`Unexpected session response: ${JSON.stringify(data)}`);
      }

      if (localSessionId) {
        webSessionCache.set(localSessionId, newSessionId);
        if (storage) {
          const key = `web_ds_session_${localSessionId}`;
          await storage.set({ [key]: newSessionId });
        }
      }
      return newSessionId;
    } catch (err) {
      lastError = err;
      if (err.message.includes("authorization failed") || err.message.includes("rejected your token")) throw err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  throw lastError || new Error("Failed to create DeepSeek web session after 3 attempts.");
}

export function scanJsonObjects(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

export function parseToolBlocks(text) {
  const calls = [];
  for (const span of scanJsonObjects(text)) {
    let obj;
    try {
      obj = JSON.parse(span);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;

    const name = obj.tool || obj.name || obj.function;
    if (!name || typeof name !== "string") continue;

    let args = obj.args || obj.parameters;
    if (!args || typeof args !== "object") {
      args = {};
      for (const [k, v] of Object.entries(obj)) {
        if (!["tool", "name", "function", "type"].includes(k)) {
          args[k] = v;
        }
      }
    }

    calls.push({
      id: `call_${calls.length}_${Date.now() % 100000}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}

export function stripToolBlocks(text) {
  let out = text;
  for (const span of scanJsonObjects(text)) {
    if (span.includes('"tool"') || span.includes('"name"')) {
      out = out.replace(span, "");
    }
  }
  return out
    .split("\n")
    .filter((line) => !["```json", "```", "``` json"].includes(line.trim()))
    .join("\n")
    .trim();
}

export async function callDeepSeekWeb({ dsToken: rawToken, messages, model, localSessionId, onChunk, signal }) {
  const dsToken = cleanToken(rawToken);
  if (!dsToken) {
    throw new Error("No DeepSeek session token configured.");
  }

  const sessionId = await ensureWebSession(dsToken, localSessionId);
  const powHeader = await getPowHeader(dsToken);

  // Build the flattened prompt string like deepseek-agent's _web_payload
  const promptParts = [];
  let budget = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const roleMap = {
      user: "User",
      assistant: "Assistant",
      tool: "Tool Result",
      system: "System Instructions",
    };
    const role = roleMap[m.role] || "System";
    const text = `${role}:\n${m.content || ""}`;
    if (budget + text.length > 75000) break;
    promptParts.unshift(text);
    budget += text.length;
  }
  const prompt = promptParts.join("\n\n");

  // Format messages array compatible with the web chat API
  const formattedMessages = messages.map((m) => {
    if (m.role === "tool") {
      return { role: "user", content: `Tool Result:\n${m.content || ""}` };
    }
    if (m.role === "system") {
      return { role: "user", content: `[System Instructions]\n${m.content || ""}` };
    }
    return { role: m.role, content: m.content || "" };
  });

  const payload = {
    chat_session_id: sessionId,
    model: model || "deepseek-chat",
    prompt,
    messages: formattedMessages,
    stream: true,
    ref_file_ids: [],
  };

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${dsToken}`,
    "X-App-Version": "20241129.1",
    ...powHeader,
  };

  const res = await fetch(`${WEB_BASE}/chat/completion`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`DeepSeek Web API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep last incomplete line

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line === "data: [DONE]" || !line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        const v = parsed?.v;
        let text = null;
        if (typeof v === "string") {
          if (!["FINISHED", "WIP", "ERROR", "INCOMPLETE"].includes(v)) {
            text = v;
          }
        } else if (v && typeof v === "object") {
          text = v.response?.content || null;
        }
        if (text) {
          fullText += text;
          if (onChunk) onChunk(text);
        }
      } catch {
        // ignore parse error on partial chunks
      }
    }
  }

  const toolCalls = parseToolBlocks(fullText);
  const cleanContent = stripToolBlocks(fullText);

  return {
    id: `web_${Date.now()}`,
    choices: [
      {
        message: {
          role: "assistant",
          content: cleanContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
  };
}
