import type { NormalizedMessage, NormalizedMessagePart, NormalizedRequest } from "./types.js";

function safeString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function normalizeRole(value: unknown): NormalizedMessage["role"] {
  if (value === "system" || value === "developer" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return "unknown";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parsePart(part: unknown): NormalizedMessagePart {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (!part || typeof part !== "object") {
    return { type: "unknown", payload: part };
  }

  const record = part as Record<string, unknown>;
  const type = safeString(record.type).toLowerCase();

  if (type === "text") {
    return { type: "text", text: safeString(record.text) };
  }
  if (type === "image" || type === "image_url") {
    return {
      type: "image",
      imageUrl: safeString(record.imageUrl || record.url || (record.image_url as Record<string, unknown>)?.url),
    };
  }
  if (type === "tool_call") {
    return {
      type: "tool_call",
      toolName: safeString(record.name || (record.function as Record<string, unknown>)?.name),
      toolCallId: safeString(record.id || record.tool_call_id),
      payload: record,
    };
  }
  if (type === "tool_result") {
    return {
      type: "tool_result",
      toolCallId: safeString(record.tool_call_id || record.id),
      payload: record,
    };
  }
  if (type === "json") {
    return { type: "json", payload: record };
  }

  if (record.tool_calls) {
    return { type: "tool_call", payload: record, toolName: "unknown" };
  }

  if (record.content && typeof record.content !== "string") {
    return { type: "json", payload: record.content };
  }

  return { type: "unknown", payload: record };
}

function normalizeMessage(message: unknown): NormalizedMessage {
  if (typeof message === "string") {
    return {
      role: "user",
      parts: [{ type: "text", text: message }],
    };
  }

  if (!message || typeof message !== "object") {
    return {
      role: "unknown",
      parts: [{ type: "unknown", payload: message }],
    };
  }

  const record = message as Record<string, unknown>;
  const role = normalizeRole(record.role);

  const content = record.content;
  let parts: NormalizedMessagePart[] = [];

  if (typeof content === "string") {
    parts = [{ type: "text", text: content }];
  } else if (Array.isArray(content)) {
    parts = content.map(parsePart);
  } else if (content && typeof content === "object") {
    parts = [parsePart(content)];
  }

  if ((record.tool_calls && Array.isArray(record.tool_calls)) || role === "tool") {
    const toolParts = asArray(record.tool_calls).map(parsePart);
    parts = parts.concat(toolParts.length ? toolParts : [{ type: role === "tool" ? "tool_result" : "tool_call", payload: record }]);
  }

  if (!parts.length) {
    parts = [{ type: "unknown", payload: record }];
  }

  return { role, parts };
}

function collectPlainText(messages: NormalizedMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.text) {
        chunks.push(part.text);
      }
      if (!part.text && part.type === "tool_call" && part.toolName) {
        chunks.push(`tool:${part.toolName}`);
      }
    }
  }
  return chunks.join("\n").trim();
}

export function normalizeRequest(input: unknown): NormalizedRequest {
  const messages = Array.isArray(input)
    ? input.map(normalizeMessage)
    : [normalizeMessage(input)];

  const plainText = collectPlainText(messages);

  let hasImage = false;
  let hasToolCall = false;
  let hasToolResult = false;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "image") hasImage = true;
      if (part.type === "tool_call") hasToolCall = true;
      if (part.type === "tool_result") hasToolResult = true;
    }
  }

  return {
    messages,
    plainText,
    hasImage,
    hasToolCall,
    hasToolResult,
  };
}

export function parseCommandInput(args?: string): unknown {
  const raw = (args || "").trim();
  if (!raw) {
    return [{ role: "user", content: "" }];
  }

  if (raw.startsWith("{" ) || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return [{ role: "user", content: raw }];
    }
  }

  return [{ role: "user", content: raw }];
}
