import type { InteractionAnswer, InteractionPrompt, RunInteraction } from './types.js';
import type { TypeSafeCatalogIssue, TypeSafeErrorCode } from './typesafe-errors.js';
export const TYPESAFE_CREDENTIAL_PREFIX = 'relay-typesafe-credential:';
export interface TypeSafeModel {
    name: string;
    description: string;
    releaseDate?: string;
}
export interface TypeSafeStatus {
    configured: boolean;
    available: boolean;
    enabled: boolean;
    model: string;
    models: TypeSafeModel[];
    validatedAt: string | null;
    error?: string;
    errorCode?: TypeSafeErrorCode;
    catalogIssue?: TypeSafeCatalogIssue;
    storage: {
        available: boolean;
        protection: string;
        error?: string;
    };
}
export interface TypeSafeCredentialRequest {
    runId?: string;
    interactionId?: string;
}
export interface TypeSafeCredentialChallenge {
    nonce: string;
    expiresAt: string;
}
export interface TypeSafeConnectRequest {
    nonce: string;
    apiKey: string;
    model?: string;
}
export type TypeSafeQuestion = {
    type: 'noul';
    instructions: string;
    criteria?: {
        true?: string;
        false?: string;
    };
} | {
    type: 'choice';
    instructions: string;
    criteria: Record<string, string | null>;
} | {
    type: 'score';
    instructions: string;
    criteria: string[];
};
export interface TypeSafeDecisionRequest {
    state: unknown;
    questions: Record<string, TypeSafeQuestion>;
}
export type TypeSafeAnswer = {
    type: 'noul';
    noul: number;
} | {
    type: 'choice';
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
} | {
    type: 'score';
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
    legend: Record<string, string>;
};
export interface TypeSafeDecisionResult {
    model: string;
    answers: Record<string, TypeSafeAnswer>;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}
export interface TypeSafeScope {
    runId: string;
    agentId: string;
    signal: AbortSignal;
    isActive: () => boolean;
    interact: (prompt: InteractionPrompt) => Promise<InteractionAnswer>;
}
export interface TypeSafeHostHooks {
    interactions?: (runId: string) => RunInteraction[];
    answer?: (runId: string, interactionId: string, answer: InteractionAnswer) => unknown;
    liveScope?: (runId: string) => {
        agentId: string;
        signal: AbortSignal;
        isActive: () => boolean;
    } | undefined;
}
