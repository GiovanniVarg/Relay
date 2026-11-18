/** Persisted manifests contain metadata only. Binary/text content stays in protected files. */
export const ATTACHMENT_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, images: 4, pixels: 16_000_000, dimension: 8192, textCharacters: 80_000, textChunk: 12_000, pdfPages: 100, zipEntries: 1000, zipExpanded: 32 * 1024 * 1024, zipEntry: 8 * 1024 * 1024, timeoutMs: 10_000 });
export type AttachmentMime = 'text/plain' | 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'image/png' | 'image/jpeg' | 'image/webp';
export interface ConversationAttachmentScope { surface?: 'conversation'; agentId: string; conversationId: string; roomId?: never; draftId?: never; }
export interface GroupAttachmentScope { surface: 'group'; roomId: string; agentId?: never; conversationId?: never; draftId?: never; }
export interface DispatcherAttachmentScope { surface: 'dispatcher'; draftId: string; agentId?: never; conversationId?: never; roomId?: never; }
export type AttachmentScope = ConversationAttachmentScope | GroupAttachmentScope | DispatcherAttachmentScope;
export interface AttachmentExtraction { parser: string; version: string; characters: number; sha256: string; sourceSha256: string; truncated: boolean; pages?: number; warnings: string[]; }
export interface MessageAttachment { id: string; name: string; mimeType: AttachmentMime; size: number; sha256: string; kind: 'image' | 'document'; width?: number; height?: number; extraction?: AttachmentExtraction; }
export type OwnedAttachment = MessageAttachment & AttachmentScope & { createdAt: string; messageId: string | null; };
export type AttachmentUpload = AttachmentScope & { name: string; mimeType: AttachmentMime; base64: string; };
export interface AttachmentParseResult { text?: string; parser: string; version: string; truncated: boolean; pages?: number; warnings: string[]; width?: number; height?: number; }
export type AttachmentErrorCode = 'invalid' | 'unsupported' | 'limit' | 'encrypted' | 'scanned' | 'timeout' | 'canceled' | 'integrity' | 'scope' | 'conflict';
