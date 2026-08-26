// Couche d'accès aux modèles d'IA (DeepSeek & Anthropic).
//
// Supporte nativement :
//   - DeepSeek V3 / V4pro / R1 via l'API officielle https://api.deepseek.com
//   - Anthropic Claude (Opus / Sonnet) via le SDK Anthropic officiel
//
// Le provider est sélectionné automatiquement :
//   - Si `DEEPSEEK_API_KEY` est défini -> DeepSeek (défaut : deepseek-chat)
//   - Sinon si `ANTHROPIC_API_KEY` est défini -> Anthropic Claude
//   - Forçable via la variable `LLM_PROVIDER="deepseek" | "anthropic"`

import Anthropic from "npm:@anthropic-ai/sdk@^0.117.1";
import { optionalEnv, optionalIntEnv } from "./env.ts";
import { ExternalApiError, withRetry } from "./errors.ts";
import type { ScopedLogger } from "./logger.ts";

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmTextBlock {
  type: "text";
  text: string;
}

export interface LlmToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock;

/** Bloc de résultat d'outil renvoyé au modèle au tour suivant. */
export interface LlmToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | Array<LlmContentBlock | LlmToolResultBlock>;
}

export interface LlmResponse {
  /** Blocs conservés pour être renvoyés tels quels dans l'historique. */
  content: LlmContentBlock[];
  stopReason: string;
  /** `true` si les classificateurs ont refusé — le contenu est vide ou partiel. */
  refused: boolean;
  refusalCategory?: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface CallAgentLlmParams {
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  logger?: ScopedLogger;
}

// ============================================================
// Provider DeepSeek (OpenAI-compatible)
// ============================================================

async function callDeepSeek(params: CallAgentLlmParams): Promise<LlmResponse> {
  const apiKey = optionalEnv("DEEPSEEK_API_KEY", "") ||
    optionalEnv("ANTHROPIC_API_KEY", "");
  if (!apiKey) {
    throw new ExternalApiError("deepseek", "Clé API DeepSeek manquante (DEEPSEEK_API_KEY).");
  }

  const model = optionalEnv("DEEPSEEK_MODEL", "deepseek-chat");
  const baseUrl = optionalEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com");

  // Conversion des outils au format OpenAI / DeepSeek
  const tools = params.tools.length > 0
    ? params.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
    : undefined;

  // Conversion de l'historique des messages
  const openAiMessages: Array<Record<string, unknown>> = [
    { role: "system", content: params.systemPrompt },
  ];

  for (const msg of params.messages) {
    if (typeof msg.content === "string") {
      openAiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (Array.isArray(msg.content)) {
      // 1. Message assistant avec tool_calls ou texte
      if (msg.role === "assistant") {
        const textParts = msg.content
          .filter((b): b is LlmTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        const toolCalls = msg.content
          .filter((b): b is LlmToolUseBlock => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          }));

        openAiMessages.push({
          role: "assistant",
          content: textParts || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } // 2. Message utilisateur contenant les tool_results
      else if (msg.role === "user") {
        const toolResults = msg.content.filter(
          (b): b is LlmToolResultBlock => b.type === "tool_result",
        );
        const textBlocks = msg.content.filter(
          (b): b is LlmTextBlock => b.type === "text",
        );

        if (toolResults.length > 0) {
          for (const res of toolResults) {
            openAiMessages.push({
              role: "tool",
              tool_call_id: res.tool_use_id,
              content: res.content,
            });
          }
        }
        if (textBlocks.length > 0) {
          openAiMessages.push({
            role: "user",
            content: textBlocks.map((b) => b.text).join("\n"),
          });
        }
      }
    }
  }

  const response = await withRetry(
    async () => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: openAiMessages,
          tools,
          tool_choice: tools ? "auto" : undefined,
          temperature: 0.3,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new ExternalApiError("deepseek", `Erreur HTTP ${res.status}: ${errorText}`, {
          status: res.status,
        });
      }

      return await res.json();
    },
    {
      attempts: 3,
      onRetry: (error, attempt, delayMs) =>
        params.logger?.warn("llm.retry", { attempt, delayMs, error: String(error) }),
    },
  );

  const choice = response.choices?.[0];
  const message = choice?.message;
  const content: LlmContentBlock[] = [];

  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }

  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      let inputArgs = {};
      try {
        inputArgs = typeof tc.function?.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : (tc.function?.arguments ?? {});
      } catch (_err) {
        inputArgs = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input: inputArgs,
      });
    }
  }

  const finishReason = choice?.finish_reason;
  const stopReason = finishReason === "tool_calls"
    ? "tool_use"
    : (finishReason === "stop" ? "end_turn" : (finishReason ?? "end_turn"));

  return {
    content,
    stopReason,
    refused: false,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: response.usage?.prompt_cache_hit_tokens ?? 0,
    },
  };
}

// ============================================================
// Provider Anthropic
// ============================================================

let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: optionalEnv("ANTHROPIC_API_KEY", ""),
    });
  }
  return anthropicClient;
}

async function callAnthropic(params: CallAgentLlmParams): Promise<LlmResponse> {
  const anthropic = getAnthropicClient();
  const model = optionalEnv("ANTHROPIC_MODEL", "claude-opus-5");
  const maxTokens = optionalIntEnv("ANTHROPIC_MAX_TOKENS", 4096);
  const fallbackBeta = "server-side-fallback-2026-07-01";

  const request = {
    model,
    max_tokens: maxTokens,
    betas: [fallbackBeta],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: [
      { type: "text", text: params.systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    tools: params.tools,
    messages: params.messages,
  };

  const response = await withRetry(
    async () => {
      try {
        // deno-lint-ignore no-explicit-any
        return await anthropic.beta.messages.create(request as any);
      } catch (cause) {
        const status = (cause as { status?: number })?.status;
        throw new ExternalApiError("anthropic", (cause as Error)?.message ?? "appel échoué", {
          status,
          cause,
        });
      }
    },
    {
      attempts: 3,
      onRetry: (error, attempt, delayMs) =>
        params.logger?.warn("llm.retry", { attempt, delayMs, error: String(error) }),
    },
    // deno-lint-ignore no-explicit-any
  ) as any;

  const stopReason: string = response.stop_reason ?? "end_turn";
  const refused = stopReason === "refusal";

  if (refused) {
    params.logger?.warn("llm.refusal", { category: response.stop_details?.category ?? null });
  }

  const content: LlmContentBlock[] = (response.content ?? [])
    .filter((block: { type: string }) => block.type === "text" || block.type === "tool_use")
    .map((block: Record<string, unknown>) =>
      block.type === "text"
        ? { type: "text", text: block.text as string }
        : {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: (block.input ?? {}) as Record<string, unknown>,
        }
    );

  return {
    content,
    stopReason,
    refused,
    refusalCategory: response.stop_details?.category ?? undefined,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

// ============================================================
// Dispatcher principal
// ============================================================

export async function callAgentLLM(params: CallAgentLlmParams): Promise<LlmResponse> {
  const provider = optionalEnv("LLM_PROVIDER", "").toLowerCase();

  if (provider === "anthropic") {
    return await callAnthropic(params);
  }

  if (provider === "deepseek" || optionalEnv("DEEPSEEK_API_KEY", "")) {
    return await callDeepSeek(params);
  }

  // Si une clé Anthropic réelle est présente
  const anthropicKey = optionalEnv("ANTHROPIC_API_KEY", "");
  if (anthropicKey && !anthropicKey.includes("placeholder")) {
    return await callAnthropic(params);
  }

  // Par défaut DeepSeek
  return await callDeepSeek(params);
}

/** Concatène les blocs texte d'une réponse en un message unique pour le lead. */
export function extractText(content: LlmContentBlock[]): string {
  return content
    .filter((block): block is LlmTextBlock => block.type === "text")
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function extractToolUses(content: LlmContentBlock[]): LlmToolUseBlock[] {
  return content.filter((block): block is LlmToolUseBlock => block.type === "tool_use");
}
