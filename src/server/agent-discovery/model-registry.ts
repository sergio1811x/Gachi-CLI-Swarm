/**
 * Agent Discovery Layer §6: well-known models per provider.
 *
 * Context windows are only listed when they are publicly documented — an
 * absent `contextWindow` renders as "unknown" in the UI instead of a made-up
 * number (spec: never show false data).
 */

export interface AgentModel {
  id: string
  name: string
  contextWindow?: number
  reasoning: boolean
}

const MODELS: Record<string, readonly AgentModel[]> = {
  claude: [
    { contextWindow: 200_000, id: 'opus', name: 'Opus', reasoning: true },
    { contextWindow: 200_000, id: 'sonnet', name: 'Sonnet', reasoning: true },
    { contextWindow: 200_000, id: 'haiku', name: 'Haiku', reasoning: false },
  ],
  codex: [
    { id: 'gpt-5-codex', name: 'GPT-5-Codex', reasoning: true },
    { id: 'o3', name: 'o3', reasoning: true },
  ],
  agy: [
    { contextWindow: 1_048_576, id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
    {
      contextWindow: 1_048_576,
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      reasoning: false,
    },
  ],
  // OpenCode models depend on the user-configured provider — unknown by design.
  opencode: [],
  qwen: [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', reasoning: false }],
}

export const getModelsForProvider = (provider: string): readonly AgentModel[] =>
  MODELS[provider] ?? []
