/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { socket } from './socket';
import { User, ChatRoom, ChatMessage } from './types';
import { MessageSquare, Plus, Users, Send, ChevronRight, X, UserCircle2, Home } from 'lucide-react';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [nicknameInput, setNicknameInput] = useState(() => sessionStorage.getItem('nickname') || '');
  
  const [globalUsers, setGlobalUsers] = useState<User[]>([]);
  const [availableRooms, setAvailableRooms] = useState<ChatRoom[]>([]);
  const [connectedNode, setConnectedNode] = useState<string | null>(null);
  
  // Tabs/Open rooms tracking
  const [openRooms, setOpenRooms] = useState<ChatRoom[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  // Data by room
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [usersByRoom, setUsersByRoom] = useState<Record<string, User[]>>({});
  
  const [messageInput, setMessageInput] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [showCreateRoom, setShowCreateRoom] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    fetch('/chat-api/auth/me')
      .then(res => {
        if (res.ok) return res.json();
        throw new Error('Not logged in');
      })
      .then(user => {
        sessionStorage.setItem('nickname', user.nickname);
        setIsCheckingAuth(false);
        // If socket is already connected, emit here
        if (socket.connected) {
          socket.emit('set-nickname', user.nickname);
        }
      })
      .catch(() => {
        sessionStorage.removeItem('nickname');
        setIsCheckingAuth(false);
      });
  }, []);

  useEffect(() => {
    const handleConnect = () => {
      const savedNickname = sessionStorage.getItem('nickname');
      if (savedNickname) {
        socket.emit('set-nickname', savedNickname);
      }
    };
    socket.on('connect', handleConnect);

    socket.on('registered', (user: User) => {
      setCurrentUser(user);
      sessionStorage.setItem('nickname', user.nickname);
      // Clear local open rooms on register since server wiped state or we are newly connected
      setOpenRooms([]);
      setActiveRoomId(null);
      fetchAvailableRooms();
      socket.emit('fetch-global-users');
    });

    socket.on('node-info', (data: { nodeId: string }) => {
      setConnectedNode(data.nodeId);
    });

    socket.on('global-users', (users: User[]) => {
      setGlobalUsers(users);
    });

    socket.on('room-created', (room: ChatRoom) => {
      setAvailableRooms(prev => [...prev, room]);
    });

    socket.on('private-room-created', (room: ChatRoom) => {
      setOpenRooms(prev => {
        if (!prev.find(r => r.id === room.id)) {
          return [...prev, room];
        }
        return prev;
      });
      setActiveRoomId(room.id);
      socket.emit('join-room', room.id);
    });

    socket.on('room-users-update', ({ roomId, users }: { roomId: string, users: User[] }) => {
      setUsersByRoom(prev => ({ ...prev, [roomId]: users }));
    });

    socket.on('message-received', (message: ChatMessage) => {
      setMessagesByRoom(prev => {
        const roomMessages = prev[message.roomId] || [];
        return {
          ...prev,
          [message.roomId]: [...roomMessages, message]
        };
      });
    });

    return () => {
      socket.off('registered');
      socket.off('node-info');
      socket.off('global-users');
      socket.off('room-created');
      socket.off('private-room-created');
      socket.off('room-users-update');
      socket.off('message-received');
      socket.off('connect', handleConnect);
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesByRoom, activeRoomId]);

  const fetchAvailableRooms = async () => {
    try {
      const res = await fetch('/chat-api/rooms');
      const data = await res.json();
      setAvailableRooms(data);
    } catch (e) {
      console.error("Failed to fetch rooms", e);
    }
  };

  const handleSetNickname = (e: React.FormEvent) => {
    e.preventDefault();
    if (nicknameInput.trim()) {
      socket.emit('set-nickname', nicknameInput.trim());
    }
  };

  const joinRoom = (room: ChatRoom) => {
    setOpenRooms(prev => {
      if (!prev.find(r => r.id === room.id)) {
        return [...prev, room];
      }
      return prev;
    });
    setActiveRoomId(room.id);
    socket.emit('join-room', room.id);
  };

  const leaveRoom = (roomId: string) => {
    socket.emit('leave-room', roomId);
    setOpenRooms(prev => prev.filter(r => r.id !== roomId));
    if (activeRoomId === roomId) {
      setActiveRoomId(null);
    }
    // Clean up local state
    setMessagesByRoom(prev => {
      const copy = { ...prev };
      delete copy[roomId];
      return copy;
    });
    setUsersByRoom(prev => {
       const copy = { ...prev };
       delete copy[roomId];
       return copy;
    });
  };

  const createRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (newRoomName.trim()) {
      socket.emit('create-room', newRoomName.trim());
      setNewRoomName('');
      setShowCreateRoom(false);
    }
  };

  const startPrivateChat = (targetUser: User) => {
    if (targetUser.id === currentUser?.id) return;
    socket.emit('create-private-room', targetUser.id);
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (messageInput.trim() && activeRoomId) {
      socket.emit('send-message', { roomId: activeRoomId, content: messageInput.trim() });
      setMessageInput('');
    }
  };

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-[#0B0C0E] flex items-center justify-center p-4 font-sans relative">
        <div className="bg-[#0E1116] p-8 rounded-2xl shadow-xl border border-[#2D333D] w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold tracking-tight mb-2 flex items-center justify-center gap-3 text-[#00F2FF]">
              <MessageSquare className="w-8 h-8 text-[#00F2FF]" />
              neo-chat
            </h1>
            <p className="text-[#64748B]">Authenticate with OpenID Connect to join the network.</p>
          </div>
          <div className="space-y-4">
            {isCheckingAuth ? (
               <div className="flex justify-center p-4">
                  <div className="w-8 h-8 border-4 border-[#00F2FF] border-t-transparent rounded-full animate-spin"></div>
               </div>
            ) : (
                <a
                  href="/chat-api/auth/login"
                  className="w-full bg-gradient-to-br from-[#00F2FF] to-[#4F46E5] hover:opacity-90 shadow-lg shadow-[#00F2FF1A] text-white font-bold rounded-lg px-4 py-3 transition-all inline-flex justify-center items-center"
                >
                  Login with Rauthy
                </a>
            )}
          </div>
        </div>
        
        {connectedNode && (
          <div className="fixed bottom-2 right-2 text-[10px] text-[#475569] font-mono select-none pointer-events-none z-50">
            Conectado ao nó: {connectedNode}
          </div>
        )}
      </div>
    );
  }

  const activeRoom = openRooms.find(r => r.id === activeRoomId);

  return (
    <div className="min-h-screen bg-[#0B0C0E] flex flex-col font-sans text-[#E2E8F0] overflow-hidden relative">
      {/* Header */}
      <header className="bg-[#14171C] border-b border-[#2D333D] flex-shrink-0 select-none">
        <div className="px-4 h-14 flex items-center justify-between">
            <h1 className="text-xl font-bold tracking-tighter flex items-center gap-2 text-[#00F2FF]">
               <MessageSquare className="w-5 h-5 text-[#00F2FF]" />
               neo-chat
            </h1>
            <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                   <div className="text-xs text-[#64748B] uppercase tracking-widest font-semibold flex items-center gap-1 justify-end">
                      <UserCircle2 className="w-3.5 h-3.5" /> Session Nickname
                   </div>
                   <div className="text-sm font-medium text-white">{currentUser.nickname}</div>
                </div>
                <div className="w-9 h-9 bg-gradient-to-br from-[#00F2FF] to-[#4F46E5] rounded-lg shadow-lg shadow-[#00F2FF1A] flex-shrink-0 flex items-center justify-center text-white font-bold text-xs">
                  {currentUser.nickname.substring(0,2).toUpperCase()}
                </div>
            </div>
        </div>
        
        {/* Tabs */}
        <div className="flex items-center px-4 overflow-x-auto scbar gap-1 pt-1 mt-[-4px]">
          <div
            className={cn(
              "group relative flex items-center gap-2 px-4 py-2 rounded-t-md cursor-pointer text-sm font-medium transition-colors border-t-2",
              activeRoomId === null 
                ? "bg-[#1E232B] border-[#00F2FF] text-white cursor-default" 
                : "bg-transparent border-transparent text-[#94A3B8] hover:bg-[#1E232B]"
            )}
            onClick={() => setActiveRoomId(null)}
          >
            <Home className="w-4 h-4" />
          </div>
          {openRooms.map(room => (
              <div
                key={room.id}
                className={cn(
                  "group relative flex items-center gap-2 px-4 py-2 rounded-t-md cursor-pointer text-sm font-medium transition-colors border-t-2",
                  activeRoomId === room.id 
                    ? "bg-[#1E232B] border-[#00F2FF] text-white cursor-default" 
                    : "bg-transparent border-transparent text-[#94A3B8] hover:bg-[#1E232B]"
                )}
                onClick={() => setActiveRoomId(room.id)}
              >
                <span>{room.isPrivate ? "@ " : "# "}{room.name.replace('PM: ', '')}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    leaveRoom(room.id);
                  }}
                  className="ml-1 p-0.5 rounded-sm text-[#475569] hover:text-[#94A3B8] transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {activeRoom ? (
          <>
            {/* Left Sidebar: Public Rooms */}
            <aside className="w-64 flex-shrink-0 border-r border-[#2D333D] bg-[#0E1116] flex flex-col p-4 hidden md:flex">
              <div className="mb-8 flex-shrink-0">
                 <button onClick={() => { setActiveRoomId(null); setShowCreateRoom(true); }} className="w-full py-2.5 px-4 bg-[#1E232B] border border-[#2D333D] hover:border-[#00F2FF] rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all mb-6">
                    <Plus className="w-4 h-4" />
                    <span>Create Room</span>
                 </button>
                 <div className="text-[10px] uppercase tracking-[0.2em] text-[#475569] font-bold mb-4">Public Rooms</div>
                 <div className="space-y-1">
                    {availableRooms.map(room => {
                       const isJoined = openRooms.some(r => r.id === room.id);
                       const isActive = activeRoomId === room.id;
                       return (
                         <div 
                           key={room.id} 
                           onClick={() => {
                             if (!isJoined) joinRoom(room);
                             else setActiveRoomId(room.id);
                           }}
                           className={cn(
                             "flex items-center justify-between p-2 rounded-md cursor-pointer group transition-colors",
                             isActive ? "bg-[#1E232B] text-white" : "text-[#94A3B8] hover:bg-[#1E232B]"
                           )}
                         >
                           <span className={cn("text-sm transition-colors block truncate", !isActive && "group-hover:text-white")}># {room.name}</span>
                         </div>
                       );
                    })}
                 </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                 <div className="text-[10px] uppercase tracking-[0.2em] text-[#475569] font-bold mb-4">Active Direct Chats</div>
                 <div className="space-y-1">
                    {openRooms.filter(r => r.isPrivate).map(room => {
                       const isActive = activeRoomId === room.id;
                       return (
                         <div 
                           key={room.id} 
                           onClick={() => setActiveRoomId(room.id)}
                           className={cn(
                             "flex items-center gap-2 p-2 rounded-md cursor-pointer group transition-colors",
                             isActive ? "bg-[#1E232B] text-white" : "text-[#94A3B8] hover:bg-[#1E232B]"
                           )}
                         >
                           <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0"></div>
                           <span className={cn("text-sm transition-colors truncate", !isActive && "group-hover:text-white")}>
                             {room.name.replace('PM: ', '')}
                           </span>
                         </div>
                       );
                    })}
                    {openRooms.filter(r => r.isPrivate).length === 0 && (
                      <span className="text-xs text-[#475569]">No active chats</span>
                    )}
                 </div>
              </div>
            </aside>

            {/* Chat Area */}
            <div className="flex-1 flex flex-col min-w-0 bg-[#0B0C0E]">
               {/* Messages */}
               <div className="flex-1 overflow-y-auto p-6 space-y-6">
                 {(messagesByRoom[activeRoom.id] || []).map(msg => {
                    const isSystem = msg.senderId === 'system';
                    const isMe = msg.senderId === currentUser.id;
                    
                    if (isSystem) {
                      return (
                         <div key={msg.id} className="flex justify-center my-4">
                           <span className="text-[10px] text-[#475569] uppercase tracking-widest font-bold bg-[#14171C] px-3 py-1 rounded border border-[#2D333D]">
                             {msg.content}
                           </span>
                         </div>
                      );
                    }

                    return (
                      <div key={msg.id} className="flex gap-4">
                         <div className={cn(
                           "w-8 h-8 rounded flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white shadow-sm",
                           isMe ? "bg-[#4F46E5]" : "bg-[#1E232B]"
                         )}>
                            {msg.senderNickname.substring(0, 2).toUpperCase()}
                         </div>
                         <div>
                           <div className="flex items-baseline gap-2 mb-1">
                              <span className={cn("font-bold text-sm", isMe ? "text-[#00F2FF]" : "text-white")}>{isMe ? "You" : msg.senderNickname}</span>
                              <span className="text-[10px] text-[#475569]">{format(new Date(msg.timestamp), 'h:mm a')}</span>
                           </div>
                           <div className={cn(
                             "text-[#CBD5E1] text-sm leading-relaxed p-3 rounded-tr-xl rounded-br-xl rounded-bl-xl border",
                             isMe ? "bg-[#1E232B] border-[#4F46E533]" : "bg-[#14171C] border-[#2D333D]"
                           )}>
                             {msg.content}
                           </div>
                         </div>
                      </div>
                    );
                 })}
                 <div ref={messagesEndRef} />
               </div>

               {/* Input Area */}
               <div className="p-4 bg-[#0E1116] border-t border-[#2D333D] flex-shrink-0">
                  <form onSubmit={sendMessage} className="flex items-center gap-3 bg-[#14171C] border border-[#2D333D] rounded-lg px-4 py-2.5 max-w-5xl mx-auto">
                    <input
                      type="text"
                      className="bg-transparent border-none outline-none text-sm text-white flex-1 placeholder-[#475569]"
                      placeholder={`Message ${activeRoom.isPrivate ? "@ " : "# "}${activeRoom.name.replace('PM: ', '')}`}
                      value={messageInput}
                      onChange={e => setMessageInput(e.target.value)}
                    />
                    <div className="h-4 w-px bg-[#2D333D]"></div>
                    <button
                      type="submit"
                      disabled={!messageInput.trim()}
                      className="text-[#475569] hover:text-[#00F2FF] disabled:opacity-50 disabled:hover:text-[#475569] transition-colors"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  </form>
               </div>
            </div>

            {/* Sidebar: Active Users */}
            <div className="w-56 flex-shrink-0 border-l border-[#2D333D] bg-[#0E1116] flex flex-col p-4 overflow-hidden hidden md:flex">
               <div className="text-[10px] uppercase tracking-[0.2em] text-[#475569] font-bold mb-6 flex items-center justify-between">
                 <span>Users in Room</span>
                 <span className="text-[#00F2FF]">{(usersByRoom[activeRoom.id] || []).length}</span>
               </div>
               <div className="flex-1 overflow-y-auto space-y-4">
                 {(usersByRoom[activeRoom.id] || []).map(user => (
                   <div key={user.id} className="flex items-center justify-between group cursor-default">
                     <div className="flex items-center gap-3 relative w-full overflow-hidden">
                       <div className="relative flex-shrink-0">
                         <div className={cn(
                           "w-8 h-8 rounded flex items-center justify-center text-[10px] font-bold text-white",
                           user.id === currentUser.id ? "bg-[#4F46E5]" : "bg-[#1E232B]"
                         )}>
                           {user.nickname.substring(0, 2).toUpperCase()}
                         </div>
                         <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-[#0E1116] rounded-full"></div>
                       </div>
                       <span className={cn(
                         "text-sm font-medium transition-colors truncate pr-6",
                         user.id === currentUser.id ? "text-white" : "text-[#94A3B8] group-hover:text-white"
                       )}>
                         {user.nickname}
                       </span>
                       
                       {user.id !== currentUser.id && (
                         <button
                           onClick={() => startPrivateChat(user)}
                           className="absolute right-0 opacity-0 group-hover:opacity-100 text-[#475569] hover:text-[#00F2FF] transition-colors bg-[#0E1116] pl-2"
                           title="Direct Message"
                         >
                           <MessageSquare className="w-4 h-4" />
                         </button>
                       )}
                     </div>
                   </div>
                 ))}
               </div>
            </div>
          </>
        ) : (
          /* Dashboard / Lobby */
          <div className="flex-1 flex flex-col max-w-5xl mx-auto w-full p-6 lg:p-8 bg-[#0B0C0E] overflow-y-auto">
            <div className="mb-8 flex justify-between items-end">
              <div>
                 <h2 className="text-3xl font-bold text-white tracking-tighter mb-2">Welcome to neo-chat</h2>
                 <p className="text-[#94A3B8]">Join a room to start talking, or create your own.</p>
              </div>
              <button
                onClick={() => setShowCreateRoom(true)}
                className="bg-[#1E232B] border border-[#2D333D] hover:border-[#00F2FF] text-white font-semibold px-4 py-2.5 rounded-lg flex items-center gap-2 transition-all"
              >
                <Plus className="w-5 h-5" />
                New Room
              </button>
            </div>

            {showCreateRoom && (
              <div className="mb-8 p-6 bg-[#14171C] border border-[#2D333D] rounded-xl">
                 <h3 className="text-[10px] uppercase tracking-[0.2em] text-[#475569] font-bold mb-4">Create Custom Room</h3>
                 <form onSubmit={createRoom} className="flex gap-3">
                   <input
                     type="text"
                     value={newRoomName}
                     onChange={e => setNewRoomName(e.target.value)}
                     placeholder="Room name..."
                     autoFocus
                     className="flex-1 bg-[#1E232B] border border-[#2D333D] text-white rounded-lg px-4 py-2 focus:outline-none focus:border-[#00F2FF]"
                   />
                   <button type="submit" className="bg-[#1E232B] border border-[#2D333D] hover:border-[#00F2FF] text-white px-6 py-2 rounded-lg font-medium transition-all">
                     Create
                   </button>
                   <button type="button" onClick={() => setShowCreateRoom(false)} className="text-[#94A3B8] hover:text-white px-4 py-2 transition-colors">
                     Cancel
                   </button>
                 </form>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
               <div className="lg:col-span-2 space-y-6">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-[#475569] font-bold flex justify-between items-center">
                    <span>Public Rooms</span>
                    <span className="text-[#00F2FF] bg-[#00F2FF22] px-1.5 py-0.5 rounded text-[10px]">{availableRooms.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                     {availableRooms.map(room => {
                        const isJoined = openRooms.some(r => r.id === room.id);
                        return (
                          <div key={room.id} className="bg-[#14171C] border border-[#2D333D] hover:border-[#00F2FF] rounded-xl p-5 hover:bg-[#1E232B] transition-all flex flex-col group cursor-pointer" onClick={() => {
                            if (!isJoined) joinRoom(room);
                            else setActiveRoomId(room.id);
                          }}>
                            <h4 className="text-lg font-bold text-[#E2E8F0] mb-1 group-hover:text-white transition-colors"># {room.name}</h4>
                            <p className="text-sm text-[#475569] mb-4 flex-1">Public chat group.</p>
                            <div
                              className={cn(
                                "w-full py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-colors",
                                isJoined ? "bg-[#1E232B] text-white border border-[#2D333D]" : "bg-transparent text-[#00F2FF] border border-[#00F2FF44] group-hover:border-[#00F2FF]"
                              )}
                            >
                               {isJoined ? "Open Room" : "Join Room"}
                               <ChevronRight className="w-4 h-4" />
                            </div>
                          </div>
                        )
                     })}
                     {availableRooms.length === 0 && (
                       <div className="col-span-full py-8 text-center border-2 border-dashed border-[#2D333D] rounded-xl text-[#475569]">
                          No public rooms available.
                       </div>
                     )}
                  </div>
               </div>
               
               <div className="space-y-6">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-[#475569] font-bold flex justify-between items-center">
                     <span>Active Direct Chats</span>
                     <span className="text-[#00F2FF] bg-[#00F2FF22] px-1.5 py-0.5 rounded text-[10px]">{globalUsers.length}</span>
                  </div>
                  <div className="bg-[#14171C] border border-[#2D333D] rounded-xl overflow-hidden flex flex-col max-h-[600px] p-2">
                     <div className="overflow-y-auto space-y-1">
                        {globalUsers.length <= 1 && <p className="text-sm text-[#475569] text-center py-4">No other users online.</p>}
                        {globalUsers.map(u => {
                          if (u.id === currentUser.id) return null;
                          return (
                            <div key={u.id} className="flex items-center gap-2 p-3 rounded-md text-[#94A3B8] hover:bg-[#1E232B] cursor-pointer group transition-colors" onClick={() => startPrivateChat(u)}>
                              <div className="relative flex-shrink-0">
                                 <div className="w-8 h-8 rounded bg-[#1E232B] flex items-center justify-center text-[10px] font-bold text-white">
                                   {u.nickname.substring(0, 2).toUpperCase()}
                                 </div>
                                 <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-[#14171C] rounded-full"></div>
                              </div>
                              <span className="text-sm font-medium group-hover:text-white transition-colors">
                                {u.nickname}
                              </span>
                              <div className="ml-auto opacity-0 group-hover:opacity-100 text-[#475569] hover:text-[#00F2FF] transition-colors p-1">
                                <MessageSquare className="w-4 h-4" />
                              </div>
                            </div>
                          )
                        })}
                     </div>
                  </div>
               </div>
            </div>
          </div>
        )}
      </div>

      {connectedNode && (
        <div className="fixed bottom-2 right-2 text-[10px] text-[#475569] font-mono select-none pointer-events-none z-50 bg-[#0B0C0E]/80 px-2 py-1 rounded">
          Conectado ao nó: {connectedNode}
        </div>
      )}
    </div>
  );
}

