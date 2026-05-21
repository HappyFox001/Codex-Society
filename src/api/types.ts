export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  response_format?: unknown;
  x_codex?: {
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    cwd?: string;
    timeoutMs?: number;
  };
}

export interface ResponsesRequest {
  model: string;
  input: string | OpenAiMessage[];
  stream?: boolean;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  x_codex?: ChatCompletionRequest["x_codex"];
}

export interface OpenAiModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ChatBackendRequest {
  model: string;
  prompt: string;
  timeoutMs?: number;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface ChatBackend {
  readonly id: string;
  readonly models: string[];
  complete(request: ChatBackendRequest): Promise<string>;
}
