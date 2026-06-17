export interface User {
  id: string; // Socket ID
  nickname: string;
}

export interface ChatRoom {
  id: string;
  name: string;
  isPrivate: boolean; // if true, it's a 1-on-1 chat
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderNickname: string;
  content: string;
  timestamp: string;
}
