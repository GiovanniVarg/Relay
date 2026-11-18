/** Finite image-only transport pins; text selections retain their existing rotating aliases. */
export const CLAUDE_IMAGE_CONTRACT = 'claude-image-pin/v1';
export const CLAUDE_IMAGE_MODELS: Readonly<Record<string, string>> = Object.freeze({sonnet:'claude-sonnet-5-5', opus:'claude-opus-5-5', haiku:'claude-haiku-5-5'});
export const CLAUDE_IMAGE_DOCS = Object.freeze(['https://code.claude.com/docs/en/model-config', 'https://platform.claude.com/docs/en/models/overview']);
export function claudeImageModel(alias: string): string | undefined {
  return Object.hasOwn(CLAUDE_IMAGE_MODELS, alias) ? CLAUDE_IMAGE_MODELS[alias] : undefined;
}
