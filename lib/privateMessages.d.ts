export interface PrivateMessage {
    id: string;
    senderId: number;
    recipientId: number;
    content: string;
    createdAt: string;
}
export const MESSAGE_MAX_LENGTH: number;
export const MESSAGE_LIMIT: number;
export const MESSAGE_TTL_SECONDS: number;
export function isUserId(value: unknown): value is number;
export function conversationKey(first: number, second: number): string;
export function isMessageContent(value: unknown): value is string;
export function publicMessage(value: unknown, first: number, second: number): PrivateMessage;
export function chronologicalMessages<T extends {id: string; createdAt: string}>(messages: T[]): T[];
