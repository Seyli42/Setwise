// Tests unitaires pour la couche LLM (DeepSeek & Anthropic).

import { assertEquals } from "jsr:@std/assert@^1.0.11";
import { callAgentLLM, extractText, extractToolUses, type LlmContentBlock } from "./llm.ts";

Deno.test("LLM : extractText extrait et concatène correctement le texte", () => {
  const blocks: LlmContentBlock[] = [
    { type: "text", text: "Bonjour !" },
    {
      type: "tool_use",
      id: "call_1",
      name: "get_slots",
      input: { date: "2026-08-27" },
    },
    { type: "text", text: "Comment puis-je vous aider ?" },
  ];

  const text = extractText(blocks);
  assertEquals(text, "Bonjour !\n\nComment puis-je vous aider ?");
});

Deno.test("LLM : extractToolUses filtre les blocs d'outils", () => {
  const blocks: LlmContentBlock[] = [
    { type: "text", text: "Bonjour !" },
    {
      type: "tool_use",
      id: "call_1",
      name: "list_available_slots",
      input: { service_type: "soin" },
    },
  ];

  const tools = extractToolUses(blocks);
  assertEquals(tools.length, 1);
  assertEquals(tools[0].name, "list_available_slots");
  assertEquals(tools[0].input.service_type, "soin");
});

Deno.test("LLM : Appel DeepSeek réel", async () => {
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey || apiKey.includes("placeholder")) {
    return; // Ignorer si pas de clé en environnement de test isolé
  }

  const response = await callAgentLLM({
    systemPrompt: "Tu es un assistant Setwise pour un institut de beauté.",
    messages: [{ role: "user", content: "Réponds uniquement par le mot 'SETWISE_OK'." }],
    tools: [],
  });

  const text = extractText(response.content);
  assertEquals(text.includes("SETWISE_OK"), true);
  assertEquals(response.usage.inputTokens > 0, true);
});
