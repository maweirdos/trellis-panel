import type * as EffectAcpSchema from "./compat.ts";

const boundedContentMetadata = (value: string | null | undefined, maximumLength: number): string =>
  value?.trim().slice(0, maximumLength) ?? "";

const MAX_ACP_CONTENT_TEXT_LENGTH = 65_536;

const boundedContentText = (value: string): string => value.slice(0, MAX_ACP_CONTENT_TEXT_LENGTH);

const boundedContentUri = (value: string | null | undefined): string => {
  const uri = boundedContentMetadata(value, 4_096);
  return uri.toLowerCase().startsWith("data:") ? "" : uri;
};

export function acpContentBlockDisplayText(
  content: EffectAcpSchema.ContentBlock,
): string | undefined {
  switch (content.type) {
    case "text":
      return boundedContentText(content.text);
    case "resource_link": {
      const label =
        boundedContentMetadata(content.title, 512) ||
        boundedContentMetadata(content.name, 512) ||
        "resource";
      const description = boundedContentMetadata(content.description, 2_048);
      const uri = boundedContentUri(content.uri);
      return `${description ? `${label}: ${description}` : label}${uri ? `\n${uri}` : ""}`;
    }
    case "resource": {
      if ("text" in content.resource) {
        return boundedContentText(content.resource.text);
      }
      const mimeType = boundedContentMetadata(content.resource.mimeType, 256);
      const uri = boundedContentUri(content.resource.uri);
      return `[ACP binary resource${mimeType ? ` (${mimeType})` : ""}${uri ? `: ${uri}` : ""}]`;
    }
    case "image": {
      const mimeType = boundedContentMetadata(content.mimeType, 256) || "unknown type";
      const uri = boundedContentUri(content.uri);
      return `[ACP image (${mimeType})${uri ? `: ${uri}` : ""}]`;
    }
    case "audio": {
      const mimeType = boundedContentMetadata(content.mimeType, 256) || "unknown type";
      return `[ACP audio (${mimeType})]`;
    }
    case "_t3_unknown":
      return `[Unsupported ACP content: ${boundedContentMetadata(content.originalType, 128) || "unknown"}]`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sessionUpdateIsReplay(params: EffectAcpSchema.SessionNotification): boolean {
  const meta = params._meta;
  return isRecord(meta) && meta.isReplay === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function recordHasKeys(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

export function mergeToolActivityData(
  previous: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  const previousRecord = asRecord(previous);
  const nextRecord = asRecord(next);
  if (!nextRecord) {
    return previousRecord;
  }
  const merged = { ...previousRecord, ...nextRecord };
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) {
      delete merged[key];
    }
  }
  if (!previousRecord || nextRecord.rawInput === null) {
    return merged;
  }
  const previousInput = asRecord(previousRecord.rawInput);
  const nextInput = asRecord(nextRecord.rawInput);
  const rawInput = recordHasKeys(nextInput) ? nextInput : (previousInput ?? nextInput);
  if (recordHasKeys(rawInput)) {
    merged.rawInput = rawInput;
  } else {
    delete merged.rawInput;
  }
  return merged;
}
