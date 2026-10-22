export interface Room { room_id: number; name: string; }
export interface RoomMessage {
    id: string;
    roomId: number;
    senderId: number;
    senderName: string;
    content: string;
    createdAt: string;
}
export function normalizeRoomName(value: unknown): string;
export function isRoomName(value: unknown): value is string;
export function publicRoom(value: unknown): Room;
export function roomKey(roomId: number): string;
export function publicRoomMessage(value: unknown, roomId: number): RoomMessage;
