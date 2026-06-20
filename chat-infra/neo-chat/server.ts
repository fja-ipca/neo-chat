import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from "@google/genai";
import crypto from 'crypto';
import os from 'os';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import session from 'express-session';
import * as client from 'openid-client';

// --- Redis Client Setup ---
const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');
const redisClient = new Redis({ 
  host: redisHost, 
  port: redisPort,
  retryStrategy(times) {
    if (times > 3) return null;
    return Math.min(times * 50, 2000);
  },
  maxRetriesPerRequest: 1
});

// Mock simple redis methods for preview environment fallback
let useRedis = true;
const memData = new Map<string, Map<string, any>>();
const memSets = new Map<string, Set<string>>();

redisClient.on('error', (err) => {
  console.error('Redis Main Client Error:', err.message);
  useRedis = false;
});
redisClient.on('connect', () => {
  useRedis = true;
});

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

async function initDB() {
  try {
    const defaultRooms = [
      { id: 'general', name: 'General', isPrivate: false },
      { id: 'tech', name: 'Technology', isPrivate: false },
      { id: 'random', name: 'Random', isPrivate: false },
    ];
    for (const r of defaultRooms) {
      if (useRedis) {
        const exists = await redisClient.hexists('chat:rooms', r.id).catch(() => false);
        if (!exists) {
          await redisClient.hset('chat:rooms', r.id, JSON.stringify(r)).catch(() => {});
        }
      } else {
        if (!memData.has('chat:rooms')) memData.set('chat:rooms', new Map());
        memData.get('chat:rooms')!.set(r.id, JSON.stringify(r));
      }
    }
  } catch (err) {
    console.warn("Could not initialize default rooms in Redis:", err);
  }
}

async function insertUser(id: string, nickname: string) {
  if (useRedis) {
    await redisClient.hset('chat:users', id, nickname).catch(() => {});
  } else {
    if (!memData.has('chat:users')) memData.set('chat:users', new Map());
    memData.get('chat:users')!.set(id, nickname);
  }
}

async function deleteUser(id: string) {
  if (useRedis) {
    await redisClient.hdel('chat:users', id).catch(() => {});
    const userRooms = await getRoomsForUser(id);
    for (const roomId of userRooms) {
      await redisClient.srem(`chat:room:${roomId}:users`, id).catch(() => {});
    }
    await redisClient.del(`chat:user:${id}:rooms`).catch(() => {});
  } else {
    memData.get('chat:users')?.delete(id);
    const rooms = memSets.get(`chat:user:${id}:rooms`) || new Set();
    for (const roomId of rooms) {
      memSets.get(`chat:room:${roomId}:users`)?.delete(id);
    }
    memSets.delete(`chat:user:${id}:rooms`);
  }
}

async function getUsers() {
  if (useRedis) {
    const users = await redisClient.hgetall('chat:users').catch(() => ({}));
    return Object.entries(users).map(([id, nickname]) => ({ id, nickname }));
  } else {
    const map = memData.get('chat:users') || new Map();
    return Array.from(map.entries()).map(([id, nickname]) => ({ id, nickname }));
  }
}

async function getUser(id: string) {
  if (useRedis) {
    const nickname = await redisClient.hget('chat:users', id).catch(() => null);
    return nickname ? { id, nickname } : null;
  } else {
    const nickname = memData.get('chat:users')?.get(id);
    return nickname ? { id, nickname } : null;
  }
}

async function getRooms() {
  if (useRedis) {
    const rooms = await redisClient.hgetall('chat:rooms').catch(() => ({}));
    return Object.values(rooms).map(req => JSON.parse(req));
  } else {
    const map = memData.get('chat:rooms') || new Map();
    return Array.from(map.values()).map(req => JSON.parse(req));
  }
}

async function getRoom(id: string) {
  if (useRedis) {
    const roomInfo = await redisClient.hget('chat:rooms', id).catch(() => null);
    return roomInfo ? JSON.parse(roomInfo) : null;
  } else {
    const roomInfo = memData.get('chat:rooms')?.get(id);
    return roomInfo ? JSON.parse(roomInfo) : null;
  }
}

async function createRoom(room: ChatRoom) {
  if (useRedis) {
    const exists = await redisClient.hexists('chat:rooms', room.id).catch(() => false);
    if (!exists) {
      await redisClient.hset('chat:rooms', room.id, JSON.stringify(room)).catch(() => {});
    }
  } else {
    if (!memData.has('chat:rooms')) memData.set('chat:rooms', new Map());
    if (!memData.get('chat:rooms')!.has(room.id)) {
      memData.get('chat:rooms')!.set(room.id, JSON.stringify(room));
    }
  }
}

async function joinRoom(roomId: string, userId: string) {
  if (useRedis) {
    await redisClient.sadd(`chat:room:${roomId}:users`, userId).catch(() => {});
    await redisClient.sadd(`chat:user:${userId}:rooms`, roomId).catch(() => {});
  } else {
    if (!memSets.has(`chat:room:${roomId}:users`)) memSets.set(`chat:room:${roomId}:users`, new Set());
    memSets.get(`chat:room:${roomId}:users`)!.add(userId);
    
    if (!memSets.has(`chat:user:${userId}:rooms`)) memSets.set(`chat:user:${userId}:rooms`, new Set());
    memSets.get(`chat:user:${userId}:rooms`)!.add(roomId);
  }
}

async function leaveRoom(roomId: string, userId: string) {
  if (useRedis) {
    await redisClient.srem(`chat:room:${roomId}:users`, userId).catch(() => {});
    await redisClient.srem(`chat:user:${userId}:rooms`, roomId).catch(() => {});
  } else {
    memSets.get(`chat:room:${roomId}:users`)?.delete(userId);
    memSets.get(`chat:user:${userId}:rooms`)?.delete(roomId);
  }
}

async function getRoomUsers(roomId: string) {
  if (useRedis) {
    const userIds = await redisClient.smembers(`chat:room:${roomId}:users`).catch(() => []);
    const userPromises = userIds.map(async (id) => {
      const nickname = await redisClient.hget('chat:users', id).catch(() => null);
      return nickname ? { id, nickname } : null;
    });
    const results = await Promise.all(userPromises);
    return results.filter(u => u !== null);
  } else {
    const userIds = Array.from(memSets.get(`chat:room:${roomId}:users`) || []);
    return userIds.map(id => {
      const nickname = memData.get('chat:users')?.get(id);
      return nickname ? { id, nickname } : null;
    }).filter(u => u !== null);
  }
}

async function getRoomsForUser(userId: string) {
  if (useRedis) {
    return await redisClient.smembers(`chat:user:${userId}:rooms`).catch(() => []);
  } else {
    return Array.from(memSets.get(`chat:user:${userId}:rooms`) || []);
  }
}

async function startServer() {
  await initDB();

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000');
  const server = http.createServer(app);

  // Setup express session
  app.use(session({
    secret: 'chat-session-secret',
    resave: false,
    saveUninitialized: true,
  }));

  const oidcIssuer = process.env.OIDC_ISSUER;
  const oidcClientId = process.env.OIDC_CLIENT_ID;
  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;
  const baseUrl = process.env.BASE_URL || 'https://chat.local';

  let oidcConfig: client.Configuration | undefined;

  if (oidcIssuer && oidcClientId) {
    const myFetch: typeof fetch = async (url, options) => {
      let reqUrl = new URL(url.toString());
      if (reqUrl.hostname === 'chat.local') {
        reqUrl.hostname = 'rauthy';
        reqUrl.port = '8080';
        reqUrl.protocol = 'http:';
      }
      return fetch(reqUrl.toString(), options);
    };
    try {
      oidcConfig = await client.discovery(
        new URL(oidcIssuer),
        oidcClientId,
        oidcClientSecret,
        undefined,
        {
          [client.customFetch]: myFetch,
          execute: [client.allowInsecureRequests]
        }
      );
      console.log('OIDC Client Initialized', oidcConfig.serverMetadata().issuer);
    } catch (e) {
      console.error('Failed to initialize OIDC:', e);
    }
  }

  // OIDC login endpoint
  app.get('/chat-api/auth/login', async (req, res) => {
    if (!oidcConfig) return res.status(500).send('OIDC not configured');
    
    let code_verifier = client.randomPKCECodeVerifier();
    let code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
    let state = client.randomState();

    (req.session as any).code_verifier = code_verifier;
    (req.session as any).state = state;

    let parameters: Record<string, string> = {
      redirect_uri: `${baseUrl}/chat-api/auth/callback`,
      scope: 'openid profile email',
      code_challenge,
      code_challenge_method: 'S256',
      state
    };

    let redirectTo = client.buildAuthorizationUrl(oidcConfig, parameters);
    res.redirect(redirectTo.href);
  });

  app.get('/chat-api/auth/callback', async (req, res) => {
    if (!oidcConfig) return res.status(500).send('OIDC not configured');
    try {
      const tokens = await client.authorizationCodeGrant(
        oidcConfig,
        new URL(`${baseUrl}/chat-api/auth/callback`),
        {
          pkceCodeVerifier: (req.session as any).code_verifier,
          expectedState: (req.session as any).state,
        }
      );
      
      const claims = tokens.claims();
      (req.session as any).user = {
         id: claims?.sub,
         nickname: claims?.preferred_username || claims?.email || 'User'
      };
      
      res.redirect('/ipca-chat/');
    } catch(e) {
      console.error('Auth callback error', e);
      res.status(500).send('Authentication failed');
    }
  });

  app.get('/chat-api/auth/me', (req, res) => {
     if ((req.session as any).user) {
       res.json((req.session as any).user);
     } else {
       res.status(401).json({ error: 'not authenticated' });
     }
  });
  
  const io = new Server(server, {
    cors: { origin: '*' }
  });
  
  if (useRedis) {
    console.log(`Initializing Socket.IO Redis Adapter on: ${redisHost}:${redisPort}`);
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();

    pubClient.on('error', (err) => {
      console.error('Redis Pub Client Error:', err.message);
    });
    subClient.on('error', (err) => {
      console.error('Redis Sub Client Error:', err.message);
    });

    io.adapter(createAdapter(pubClient, subClient));
  } else {
    console.warn('Starting without Socket.IO Redis Adapter (useRedis is false)');
  }

  app.get('/chat-api/health', (req, res) => {
    res.json({ status: 'ok', dbConnected: redisClient.status === 'ready' });
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
            model: "gemini-3.1-flash-lite",
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
