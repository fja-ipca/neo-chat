import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from "@google/genai";
import crypto from 'crypto';
import pg from 'pg';
import os from 'os';
import { createAdapter } from '@socket.io/postgres-adapter';

const { Pool } = pg;

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

// In-memory fallbacks
const memUsers = new Map<string, User>();
const memRooms = new Map<string, ChatRoom>();
const memRoomUsers = new Map<string, Set<string>>();

const pool = new Pool({
  user: process.env.POSTGRESQL_USERNAME || 'chat_admin',
  host: process.env.DB_HOST || 'pgpool', 
  database: process.env.POSTGRESQL_DATABASE || 'chat_db',
  password: process.env.POSTGRESQL_PASSWORD || 'senha_secreta',
  port: parseInt(process.env.DB_PORT || '5432'),
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

let isDBConnected = false;

async function initDB() {
  try {
    await pool.query('SELECT 1'); // Ping
    console.log("Connected to PostgreSQL -> Using DB for State and Pub/Sub");
    isDBConnected = true;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_users (
        id TEXT PRIMARY KEY,
        nickname TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id TEXT PRIMARY KEY,
        name TEXT,
        is_private BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS chat_room_users (
        room_id TEXT,
        user_id TEXT,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS socket_io_attachments (
          id          bigserial UNIQUE,
          created_at  timestamptz DEFAULT NOW(),
          payload     bytea
      );
    `);

    const defaultRooms = [
      { id: 'general', name: 'General', isPrivate: false },
      { id: 'tech', name: 'Technology', isPrivate: false },
      { id: 'random', name: 'Random', isPrivate: false },
    ];

    for (const r of defaultRooms) {
      await pool.query('INSERT INTO chat_rooms (id, name, is_private) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [r.id, r.name, r.isPrivate]);
    }
  } catch (err: any) {
    console.warn("Could not connect to PostgreSQL. Falling back to in-memory mode.", err.message);
    const defaultRooms = [
      { id: 'general', name: 'General', isPrivate: false },
      { id: 'tech', name: 'Technology', isPrivate: false },
      { id: 'random', name: 'Random', isPrivate: false },
    ];
    defaultRooms.forEach((r) => {
      memRooms.set(r.id, r);
      memRoomUsers.set(r.id, new Set());
    });
  }
}

async function insertUser(id: string, nickname: string) {
    if (isDBConnected) {
       await pool.query(
        'INSERT INTO chat_users (id, nickname) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET nickname = EXCLUDED.nickname',
        [id, nickname]
      );
    } else {
       memUsers.set(id, { id, nickname });
    }
}

async function deleteUser(id: string) {
    if (isDBConnected) {
       await pool.query('DELETE FROM chat_room_users WHERE user_id = $1', [id]);
       await pool.query('DELETE FROM chat_users WHERE id = $1', [id]);
    } else {
       memUsers.delete(id);
    }
}

async function getUsers() {
    if (isDBConnected) {
       const res = await pool.query('SELECT * FROM chat_users');
       return res.rows.map(r => ({ id: r.id, nickname: r.nickname }));
    }
    return Array.from(memUsers.values());
}

async function getUser(id: string) {
    if (isDBConnected) {
       const res = await pool.query('SELECT * FROM chat_users WHERE id = $1', [id]);
       if (res.rows.length === 0) return null;
       return { id: res.rows[0].id, nickname: res.rows[0].nickname };
    }
    return memUsers.get(id) || null;
}

async function getRooms() {
    if (isDBConnected) {
       const res = await pool.query('SELECT * FROM chat_rooms');
       return res.rows.map(r => ({ id: r.id, name: r.name, isPrivate: r.is_private }));
    }
    return Array.from(memRooms.values());
}

async function getRoom(id: string) {
    if (isDBConnected) {
       const res = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [id]);
       if (res.rows.length === 0) return null;
       return { id: res.rows[0].id, name: res.rows[0].name, isPrivate: res.rows[0].is_private };
    }
    return memRooms.get(id) || null;
}

async function createRoom(room: ChatRoom) {
    if (isDBConnected) {
       await pool.query('INSERT INTO chat_rooms (id, name, is_private) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [room.id, room.name, room.isPrivate]);
    } else {
       if (!memRooms.has(room.id)) {
           memRooms.set(room.id, room);
           memRoomUsers.set(room.id, new Set());
       }
    }
}

async function joinRoom(roomId: string, userId: string) {
    if (isDBConnected) {
       await pool.query('INSERT INTO chat_room_users (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roomId, userId]);
    } else {
       const usersInRoom = memRoomUsers.get(roomId);
       if (usersInRoom) usersInRoom.add(userId);
    }
}

async function leaveRoom(roomId: string, userId: string) {
    if (isDBConnected) {
       await pool.query('DELETE FROM chat_room_users WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    } else {
       const usersInRoom = memRoomUsers.get(roomId);
       if (usersInRoom) usersInRoom.delete(userId);
    }
}

async function getRoomUsers(roomId: string) {
    if (isDBConnected) {
       const res = await pool.query(`
           SELECT u.id, u.nickname FROM chat_users u
           JOIN chat_room_users cru ON u.id = cru.user_id
           WHERE cru.room_id = $1
       `, [roomId]);
       return res.rows.map(r => ({ id: r.id, nickname: r.nickname }));
    }
    return Array.from(memRoomUsers.get(roomId) || [])
      .map(id => memUsers.get(id))
      .filter(u => !!u);
}

async function getRoomsForUser(userId: string) {
    if (isDBConnected) {
       const res = await pool.query('SELECT room_id FROM chat_room_users WHERE user_id = $1', [userId]);
       return res.rows.map(r => r.room_id);
    }
    const rooms = [];
    for (const [roomId, users] of memRoomUsers.entries()) {
        if (users.has(userId)) rooms.push(roomId);
    }
    return rooms;
}

async function startServer() {
  await initDB();

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000');
  const server = http.createServer(app);
  
  const io = new Server(server, {
    cors: { origin: '*' }
  });
  
  if (isDBConnected) {
     io.adapter(createAdapter(pool));
  }

  app.get('/chat-api/health', (req, res) => {
    res.json({ status: 'ok', dbConnected: isDBConnected });
  });

  app.get('/chat-api/rooms', async (req, res) => {
    const rooms = await getRooms();
    const publicRooms = rooms.filter((r: any) => !r.isPrivate);
    res.json(publicRooms);
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.emit('node-info', { nodeId: os.hostname() });

    socket.on('set-nickname', async (nickname: string) => {
      await insertUser(socket.id, nickname);
      const user = await getUser(socket.id);
      socket.emit('registered', user);
      
      const allUsers = await getUsers();
      io.emit('global-users', allUsers);
    });

    socket.on('fetch-global-users', async () => {
      const allUsers = await getUsers();
      socket.emit('global-users', allUsers);
    });

    socket.on('create-room', async (name: string) => {
      const roomId = crypto.randomUUID();
      const newRoom = { id: roomId, name, isPrivate: false };
      
      await createRoom(newRoom);
      io.emit('room-created', newRoom);
    });

    socket.on('create-private-room', async (targetUserId: string) => {
      const currentUser = await getUser(socket.id);
      const targetUser = await getUser(targetUserId);

      if (!currentUser || !targetUser) return;

      const ids = [currentUser.id, targetUser.id].sort();
      const roomId = `private-${ids[0]}-${ids[1]}`;

      const existingRm = await getRoom(roomId);
      if (!existingRm) {
        await createRoom({
           id: roomId,
           name: `PM: ${currentUser.nickname} & ${targetUser.nickname}`,
           isPrivate: true
        });
      }
      
      const rmInfo = await getRoom(roomId);
      socket.emit('private-room-created', rmInfo);
      io.to(targetUserId).emit('private-room-created', rmInfo);
    });

    socket.on('join-room', async (roomId: string) => {
      const rmInfo = await getRoom(roomId);
      if (!rmInfo) return;

      socket.join(roomId);
      await joinRoom(roomId, socket.id);

      const updatedUsers = await getRoomUsers(roomId);
      io.to(roomId).emit('room-users-update', { roomId, users: updatedUsers });
      
      const user = await getUser(socket.id);
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

    socket.on('leave-room', async (roomId: string) => {
      socket.leave(roomId);
      await leaveRoom(roomId, socket.id);

      const updatedUsers = await getRoomUsers(roomId);
      io.to(roomId).emit('room-users-update', { roomId, users: updatedUsers });

      const user = await getUser(socket.id);
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
      const user = await getUser(socket.id);
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
              headers: { 'User-Agent': 'aistudio-build' }
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

    socket.on('disconnect', async () => {
      console.log('User disconnected:', socket.id);
      const user = await getUser(socket.id);
      
      const userRooms = await getRoomsForUser(socket.id);
      await deleteUser(socket.id);

      for (const roomId of userRooms) {
        const updatedUsers = await getRoomUsers(roomId);
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
      
      const allUsers = await getUsers();
      io.emit('global-users', allUsers);
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use((vite as any).middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
