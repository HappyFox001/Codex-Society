import http from "node:http";
import { pathToFileURL } from "node:url";
import { CodexCliBackend, EchoBackend, StaticDecisionBackend } from "./backends.js";
import type { ChatBackend, ChatCompletionRequest, OpenAiMessage, ResponsesRequest } from "./types.js";

export interface ApiServerOptions {
  backend: ChatBackend;
  port?: number;
  host?: string;
  apiKey?: string;
}

export function createOpenAiCompatibleServer(options: ApiServerOptions): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if (options.apiKey && !isAuthorized(request, options.apiKey)) {
        sendJson(response, 401, { error: { message: "Unauthorized", type: "auth_error" } });
        return;
      }

      if (request.method === "GET" && request.url === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: options.backend.models.map((model) => ({
            id: model,
            object: "model",
            created: 0,
            owned_by: options.backend.id,
          })),
        });
        return;
      }

      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const body = await readJson<ChatCompletionRequest>(request);
        const prompt = messagesToPrompt(body.messages);
        const content = await options.backend.complete({
          model: body.model,
          prompt,
          cwd: body.x_codex?.cwd,
          sandbox: body.x_codex?.sandbox,
          timeoutMs: body.x_codex?.timeoutMs,
        });

        sendJson(response, 200, chatCompletion(body.model, normalizeBackendContent(content)));
        return;
      }

      if (request.method === "POST" && request.url === "/v1/responses") {
        const body = await readJson<ResponsesRequest>(request);
        const prompt = responsesInputToPrompt(body.input, body.instructions);
        const content = await options.backend.complete({
          model: body.model,
          prompt,
          cwd: body.x_codex?.cwd,
          sandbox: body.x_codex?.sandbox,
          timeoutMs: body.x_codex?.timeoutMs,
        });

        sendJson(response, 200, responseObject(body.model, normalizeBackendContent(content)));
        return;
      }

      sendJson(response, 404, { error: { message: "Not found", type: "not_found" } });
    } catch (error) {
      sendJson(response, 500, {
        error: {
          message: error instanceof Error ? error.message : "Unknown server error",
          type: "server_error",
        },
      });
    }
  });
}

export async function startOpenAiCompatibleServer(options: ApiServerOptions): Promise<http.Server> {
  const server = createOpenAiCompatibleServer(options);
  const port = options.port ?? 8787;
  const host = options.host ?? "127.0.0.1";

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.log(`OpenAI-compatible gateway listening on http://${host}:${port}`);
  console.log(`Backend: ${options.backend.id}`);
  return server;
}

function isAuthorized(request: http.IncomingMessage, apiKey: string): boolean {
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${apiKey}`;
}

function readJson<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function messagesToPrompt(messages: OpenAiMessage[]): string {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${contentToText(message.content)}`).join("\n\n");
}

function responsesInputToPrompt(input: ResponsesRequest["input"], instructions?: string): string {
  const inputText = typeof input === "string" ? input : messagesToPrompt(input);
  return instructions ? `SYSTEM:\n${instructions}\n\nUSER:\n${inputText}` : inputText;
}

function contentToText(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => part.text ?? "").join("\n");
}

function normalizeBackendContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { content?: unknown };
    if (typeof parsed.content === "string") {
      return parsed.content;
    }
  } catch {
    // Plain text backend output is valid for OpenAI-compatible responses.
  }
  return content;
}

function chatCompletion(model: string, content: string) {
  return {
    id: `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

function responseObject(model: string, content: string) {
  return {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output_text: content,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: content,
          },
        ],
      },
    ],
  };
}

function backendFromEnv(): ChatBackend {
  const backend = process.env.CODEX_SOCIETY_BACKEND ?? "static";
  if (backend === "codex") {
    return new CodexCliBackend({
      defaultCwd: process.env.CODEX_SOCIETY_CODEX_CWD,
      defaultSandbox: parseSandbox(process.env.CODEX_SOCIETY_CODEX_SANDBOX),
      timeoutMs: process.env.CODEX_SOCIETY_CODEX_TIMEOUT_MS
        ? Number(process.env.CODEX_SOCIETY_CODEX_TIMEOUT_MS)
        : undefined,
    });
  }
  if (backend === "echo") {
    return new EchoBackend();
  }
  return new StaticDecisionBackend();
}

function parseSandbox(value: string | undefined) {
  if (value === "workspace-write" || value === "danger-full-access" || value === "read-only") {
    return value;
  }
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startOpenAiCompatibleServer({
    backend: backendFromEnv(),
    host: process.env.HOST,
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    apiKey: process.env.CODEX_SOCIETY_API_KEY,
  });
}
