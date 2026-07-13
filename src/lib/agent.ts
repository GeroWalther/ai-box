import { invokeCmd, streamCmd } from "./transport";

// OpenAI-format tool definitions the model can call in Agent mode.
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file's full contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute file path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file with the given content. Parent folders are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries in a directory. Directories end with '/'.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute directory path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command (sh -c) on the user's Mac. Use for installs, builds, git, running scripts. Output streams live. The user must approve each command before it runs.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Recursively search a directory by file name and/or file contents (like grep/find). Returns matching paths and 'path:line: text' hits. Skips node_modules/.git/etc.",
      parameters: {
        type: "object",
        properties: {
          root: { type: "string", description: "Absolute directory to search from" },
          query: { type: "string", description: "Text to look for" },
          kind: { type: "string", enum: ["name", "content", "both"], description: "Match filenames, contents, or both (default both)" },
        },
        required: ["root", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Make a targeted edit: replace the first exact, unique occurrence of `old` with `new` in a file. Prefer this over write_file for small changes. Returns a diff.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          old: { type: "string", description: "Exact existing text to replace (must be unique in the file)" },
          new: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old", "new"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "Move or rename a file/folder. The user must approve this.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Absolute source path" },
          to: { type: "string", description: "Absolute destination path" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or directory (recursive). The user must approve this.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to delete" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return its readable text (HTML stripped). Use to read docs/pages.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_story",
      description:
        "Append prose to the user's open manuscript in the Write tab. Use when asked to draft or continue their novel/story. Pass the finished prose only.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The prose to append (plain text; blank lines separate paragraphs)" } },
        required: ["text"],
      },
    },
  },
];

const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.function.name));

function tryJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Extract the first balanced {...} JSON object from text (handles ``` fences). */
function extractJsonObject(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) return tryJson(body.slice(start, i + 1));
    }
  }
  return null;
}

/**
 * Parse a tool call from a model's FREE-TEXT reply — the ReAct fallback for local
 * models (Ollama, etc.) that don't emit native OpenAI `tool_calls`. Supports:
 *   - JSON: {"tool"|"name"|"action": "read_file", "args"|"arguments"|"action_input": {…}}
 *   - ReAct: "Action: read_file\nAction Input: {…}"
 * Returns null when no known tool is referenced → the caller treats it as the
 * model's final answer. Only names in AGENT_TOOLS are accepted.
 */
export function parseTextToolCall(content: string): { name: string; args: any } | null {
  if (!content) return null;

  // 1. A JSON object naming a tool.
  const obj = extractJsonObject(content);
  if (obj && typeof obj === "object") {
    const name = obj.tool || obj.name || obj.action || obj.function?.name;
    if (typeof name === "string" && TOOL_NAMES.has(name)) {
      let args =
        obj.args ??
        obj.arguments ??
        obj.action_input ??
        obj.parameters ??
        obj.input ??
        obj.function?.arguments ??
        {};
      if (typeof args === "string") args = tryJson(args) ?? {};
      return { name, args: args && typeof args === "object" ? args : {} };
    }
  }

  // 2. ReAct "Action: <tool>" + "Action Input: <json>".
  const nameM = content.match(/(?:^|\n)\s*(?:action|tool)\s*:\s*["']?([a-zA-Z_]+)/i);
  if (nameM && TOOL_NAMES.has(nameM[1])) {
    const inM = content.match(/(?:action[ _]?input|args|arguments|input)\s*:\s*([\s\S]+)/i);
    let args: any = {};
    if (inM) {
      const parsed = extractJsonObject(inM[1]) ?? tryJson(inM[1].trim());
      if (parsed && typeof parsed === "object") args = parsed;
    }
    return { name: nameM[1], args };
  }

  return null;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}

export interface ChatCompletionArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  tools: unknown[];
  temperature: number;
}

export async function chatCompletion(args: ChatCompletionArgs): Promise<AssistantMessage> {
  return invokeCmd<AssistantMessage>("chat_completion", { params: args });
}

export const fsRead = (path: string) => invokeCmd<string>("fs_read", { path });
export const fsWrite = (path: string, content: string) =>
  invokeCmd<string>("fs_write", { path, content });
export const fsList = (path: string) => invokeCmd<string[]>("fs_list", { path });
export const runCommand = (command: string) =>
  invokeCmd<{ stdout: string; stderr: string; code: number }>("run_command", { command });

export const fsSearch = (root: string, query: string, kind?: string) =>
  invokeCmd<string[]>("fs_search", { root, query, kind: kind ?? null });
export const fsEdit = (path: string, oldStr: string, newStr: string) =>
  invokeCmd<{ message: string; diff: string }>("fs_edit", { path, old: oldStr, new: newStr });
export const fsMove = (from: string, to: string) => invokeCmd<string>("fs_move", { from, to });
export const fsDelete = (path: string) => invokeCmd<string>("fs_delete", { path });
export const webFetch = (url: string) => invokeCmd<string>("web_fetch", { url });

export type CmdEvent =
  | { type: "line"; text: string }
  | { type: "done"; code: number }
  | { type: "error"; message: string };

/** Run a shell command, streaming output lines, resolving with the aggregate. */
export function runCommandStream(
  command: string,
  onLine: (line: string) => void,
  timeoutSecs?: number
): Promise<{ output: string; code: number; timedOut?: boolean }> {
  return streamCmd(
    "run_command_stream",
    { command, timeoutSecs: timeoutSecs ?? null },
    (e: CmdEvent) => {
      if (e.type === "line") onLine(e.text);
      else if (e.type === "error") onLine(`[${e.message}]`);
    }
  );
}
