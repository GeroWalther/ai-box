import { invoke } from "@tauri-apps/api/core";

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
        "Run a shell command (sh -c) on the user's Mac. Use for installs, builds, git, running scripts. The user must approve each command before it runs.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command" } },
        required: ["command"],
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
  return invoke<AssistantMessage>("chat_completion", { params: args });
}

export const fsRead = (path: string) => invoke<string>("fs_read", { path });
export const fsWrite = (path: string, content: string) =>
  invoke<string>("fs_write", { path, content });
export const fsList = (path: string) => invoke<string[]>("fs_list", { path });
export const runCommand = (command: string) =>
  invoke<{ stdout: string; stderr: string; code: number }>("run_command", { command });
