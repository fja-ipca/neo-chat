import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { v4 as uuidv4 } from 'uuid'; // need to install uuid
import { GoogleGenAI } from "@google/genai";

// We'll not use uuid library right now, let's use a simple generator or socket ids string.
// Let's use crypto.randomUUID() which is built-in in node.
import crypto from 'crypto';

interface User {
  id: string; // Socket ID
  nickname: string;
}

interface ChatRoom {
  id: string;
  name: string;
  isPrivate: boolean; // if true, it's a 1-on-1 chat
}

interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderNickname: string;
  content: string;
  timestamp: string;
}

// In-memory data store
const users = new Map<string, User>(); // socketId -> User
const rooms = new Map<string, ChatRoom>(); // roomId -> Room
// A set to track who is in which room: roomID -> Set<socketId>
const roomUsers = new Map<string, Set<string>>();

// Setup initial public rooms
const defaultRooms = [
  { id: 'general', name: 'General', isPrivate: false },
  { id: 'tech', name: 'Technology', isPrivate: false },
  { id: 'random', name: 'Random', isPrivate: false },
];
defaultRooms.forEach((r) => {
  rooms.set(r.id, r);
  roomUsers.set(r.id, new Set());
});

async function startServer() {
  const app = express();
  const PORT = 3000;
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*' }
  });

  // REST API (if needed)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/rooms', (req, res) => {
    // Only return public rooms as list
    const publicRooms = Array.from(rooms.values()).filter((r) => !r.isPrivate);
    res.json(publicRooms);
  });

  // Websocket handling
  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial event when user sets nickname
    socket.on('set-nickname', (nickname: string) => {
      const user = { id: socket.id, nickname };
      users.set(socket.id, user);
      socket.emit('registered', user);
      // broadcast global active users update if needed
      io.emit('global-users', Array.from(users.values()));
    });

    socket.on('fetch-global-users', () => {
      socket.emit('global-users', Array.from(users.values()));
    });

    socket.on('create-room', (name: string) => {
      const roomId = crypto.randomUUID();
      const newRoom = { id: roomId, name, isPrivate: false };
      rooms.set(roomId, newRoom);
      roomUsers.set(roomId, new Set());
      io.emit('room-created', newRoom);
    });

    socket.on('create-private-room', (targetUserId: string) => {
      const currentUser = users.get(socket.id);
      const targetUser = users.get(targetUserId);

      if (!currentUser || !targetUser) return;

      // Unique room ID based on sorted IDs to ensure both get same ID
      const ids = [currentUser.id, targetUser.id].sort();
      const roomId = `private-${ids[0]}-${ids[1]}`;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          name: `PM: ${currentUser.nickname} & ${targetUser.nickname}`,
          isPrivate: true,
        });
        roomUsers.set(roomId, new Set());
      }
      
      // Let both know they have a private room available
      socket.emit('private-room-created', rooms.get(roomId));
      io.to(targetUserId).emit('private-room-created', rooms.get(roomId));
    });

    socket.on('join-room', (roomId: string) => {
      if (!rooms.has(roomId)) return;

      socket.join(roomId);
      
      const usersInRoom = roomUsers.get(roomId);
      if (usersInRoom) {
        usersInRoom.add(socket.id);
      }

      // Broadcast to people in the room about the updated user list
      const updatedUsers = Array.from(roomUsers.get(roomId) || [])
        .map(id => users.get(id))
        .filter(u => !!u);
      
      io.to(roomId).emit('room-users-update', { roomId, users: updatedUsers });
      
      // Tell others a new user joined
      const user = users.get(socket.id);
      if (user) {
         io.to(roomId).emit('message-received', {
            id: crypto.randomUUID(),
            roomId,
            senderId: 'system',
            senderNickname: 'System',
            content: `${user.nickname} joined the room`,
            timestamp: new Date().toISOString()
         });
      }
    });

    socket.on('leave-room', (roomId: string) => {
      socket.leave(roomId);
      const usersInRoom = roomUsers.get(roomId);
      if (usersInRoom) {
        usersInRoom.delete(socket.id);
      }

      const updatedUsers = Array.from(roomUsers.get(roomId) || [])
        .map(id => users.get(id))
        .filter(u => !!u);
      
      io.to(roomId).emit('room-users-update', { roomId, users: updatedUsers });

      const user = users.get(socket.id);
      if (user) {
         io.to(roomId).emit('message-received', {
            id: crypto.randomUUID(),
            roomId,
            senderId: 'system',
            senderNickname: 'System',
            content: `${user.nickname} left the room`,
            timestamp: new Date().toISOString()
         });
      }
    });

    socket.on('send-message', async (data: { roomId: string, content: string }) => {
      const user = users.get(socket.id);
      if (!user) return;

      const message: ChatMessage = {
        id: crypto.randomUUID(),
        roomId: data.roomId,
        senderId: user.id,
        senderNickname: user.nickname,
        content: data.content,
        timestamp: new Date().toISOString(),
      };

      io.to(data.roomId).emit('message-received', message);

      if (data.content.includes('@gemini')) {
        try {
          const ai = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              }
            }
          });
          
          const prompt = data.content.replace(/@gemini/g, '').trim() || "Hi!";
          const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: prompt,
          });

          if (response.text) {
             io.to(data.roomId).emit('message-received', {
                id: crypto.randomUUID(),
                roomId: data.roomId,
                senderId: 'gemini',
                senderNickname: 'Gemini',
                content: response.text,
                timestamp: new Date().toISOString()
             });
          }
        } catch (e: any) {
           console.error("Gemini Error:", e);
           io.to(data.roomId).emit('message-received', {
                id: crypto.randomUUID(),
                roomId: data.roomId,
                senderId: 'system',
                senderNickname: 'System',
                content: `Error contacting Gemini: ${e.message}`,
                timestamp: new Date().toISOString()
           });
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      const user = users.get(socket.id);
      users.delete(socket.id);

      // Clean up rooms
      roomUsers.forEach((userIds, roomId) => {
        if (userIds.has(socket.id)) {
          userIds.delete(socket.id);
          const updatedUsers = Array.from(userIds)
            .map(id => users.get(id))
            .filter(u => !!u);
          io.to(roomId).emit('room-users-update', { roomId, users: updatedUsers });
          
          if (user) {
            io.to(roomId).emit('message-received', {
               id: crypto.randomUUID(),
               roomId,
               senderId: 'system',
               senderNickname: 'System',
               content: `${user.nickname} disconnected`,
               timestamp: new Date().toISOString()
            });
          }
        }
      });
      io.emit('global-users', Array.from(users.values()));
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    // app.use(vite.middlewares) will handle serving Vite's transformed files
    // But since express v4 doesn't have good type typings for it sometimes, we use any:
    app.use((vite as any).middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
