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
