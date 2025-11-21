import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import TelegramBot from "node-telegram-bot-api";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { getAutoReply } from "./getAutoReplies.js"; 
// import { getAIReply } from "./aiReply.js";

dotenv.config();

const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:8080";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ENABLE_TELEGRAM = !!TELEGRAM_TOKEN;

// Initialize Supabase client
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ;

let supabase: ReturnType<typeof createClient> | null = null;

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log("💾 Supabase client initialized");
} else {
  console.log("ℹ️ Supabase not configured - chat history will not be saved");
}

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST"]
  }
});

// Enhanced in-memory state
interface Message {
  from: "user" | "agent" | "bot" | "system";
  text: string;
  timestamp: number;
  agentId?: string;
  agentName?: string;
}

interface ChatState {
  mode: "bot" | "human";
  agentId?: string;
  agentName?: string;
  messages: Message[];
  source: "web" | "telegram";
  requestingHuman?: boolean; // Flag for human support request
  userFirstName?: string; // User's first name
  userLastName?: string; // User's last name
  userId?: string; // Supabase user ID for persistence
}

const activeChats = new Map<string, ChatState>();

// Helper function to save message to Supabase (inserts individual message as a row)
async function saveMessageToDatabase(chatId: string, message: Message, userId?: string) {
  if (!supabase || !userId) return;

  try {
    // First ensure chat session exists
    const { data: existingSession } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('id', chatId)
      .maybeSingle();

    const chat = activeChats.get(chatId);
    
    if (!existingSession) {
      // Create session if it doesn't exist
      await (supabase.from('chat_sessions') as any).insert({
        id: chatId,
        user_id: userId,
        mode: chat?.mode || 'bot',
        agent_id: chat?.agentId || null,
        requesting_human: chat?.requestingHuman || false,
        source: chat?.source || 'web',
        user_first_name: chat?.userFirstName || null,
        user_last_name: chat?.userLastName || null
      });
      console.log(`💾 Created chat session in database: ${chatId}`);
    }

    // Check if chat_messages entry exists for this chat_id (ONE ROW PER CHAT)
    const { data: existingMessages, error: selectError } = await supabase
      .from('chat_messages')
      .select('chat_id, chat_history')
      .eq('chat_id', chatId)
      // Only consider non-archived rows (archived is stored as boolean)
      .eq('archived', false)
      .maybeSingle();

    if (selectError) {
      console.error(`❌ Failed to read existing chat_messages row for ${chatId}:`, selectError);
      return;
    }
    //@ts-expect-error type update
    if (!existingMessages || existingMessages.archived === true) {
      // Create new chat_messages entry with initial message in chat_history
      await (supabase.from('chat_messages') as any).insert({
        chat_id: chatId,
        chat_history: [message]
      });
      console.log(`💾 Created chat_messages row with initial message: ${chatId}`);
    } else {
      // Append message to existing chat_history in the single row for this chat
      const currentHistory = (existingMessages as any).chat_history || [];
      const updatedHistory = [...currentHistory, message];
      
      await (supabase
        .from('chat_messages') as any)
        .update({ 
          chat_history: updatedHistory,
          updated_at: new Date().toISOString()
        })
        .eq('chat_id', chatId);
      
      console.log(`💾 Appended message to chat_history for chat ${chatId}`);
    }

    // Update chat session's updated_at
    await (supabase
      .from('chat_sessions') as any)
      .update({ updated_at: new Date().toISOString() })
      .eq('id', chatId);

  } catch (error) {
    console.error(`❌ Failed to save message to database:`, error);
  }
}

// Helper function to load chat history from Supabase (from chat_history JSONB field in chat_messages table)
async function loadChatHistoryFromDatabase(chatId: string): Promise<Message[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('chat_history')
      .eq('chat_id', chatId)
      .maybeSingle();

    if (error) {
      console.error(`❌ Failed to load chat history:`, error);
      return [];
    }

    return ((data as any)?.chat_history || []) as Message[];
  } catch (error) {
    console.error(`❌ Failed to load chat history:`, error);
    return [];
  }
}

let bot: TelegramBot | null = null;

// Initialize Telegram bot if token is provided
if (ENABLE_TELEGRAM) {
  bot = new TelegramBot(TELEGRAM_TOKEN!, { 
    polling: {
      interval: 1000,
      autoStart: true,
      params: {
        timeout: 10
      }
    }
  });

  bot.on('polling_error', (error) => {
    console.log('⚠️ Telegram polling error:', error.message);
  });

  bot.on('webhook_error', (error) => {
    console.error('⚠️ Telegram webhook error:', error);
  });

  console.log("📱 Telegram bot enabled");
} else {
  console.log("ℹ️ Telegram bot disabled (no token provided)");
}

// Helper to emit chat event to dashboard
function emitToDashboard(event: string, payload: any) {
  io.emit(event, payload);
}

// Helper to store message in chat history
function storeMessage(chatId: string, message: Message, userId?: string) {
  const chat = activeChats.get(chatId);
  if (chat) {
    chat.messages.push(message);
    
    // Save to database asynchronously
    const finalUserId = userId || chat.userId;
    if (finalUserId) {
      saveMessageToDatabase(chatId, message, finalUserId).catch(err => {
        console.error(`❌ Error saving message to database:`, err);
      });
    }
  }
}

// Helper to send bot message (works for both web and Telegram)
async function sendBotMessage(chatId: string, text: string) {
  const chat = activeChats.get(chatId);
  
  // Send via Telegram if it's a Telegram chat
  if (chat?.source === "telegram" && bot) {
    try {
      await bot.sendMessage(chatId, text);
    } catch (error) {
      console.error(`Failed to send Telegram message to ${chatId}:`, error);
    }
  }
  
  // Store and emit bot message (for both web and Telegram)
  const message: Message = {
    from: "bot",
    text,
    timestamp: Date.now()
  };
  
  storeMessage(chatId, message, chat?.userId);
  emitToDashboard("bot_message", { chatId, text });
  
  console.log(`🤖 Bot sent message to ${chatId}: ${text}`);
}

// Bot auto-reply logic with human support request handling
async function handleBotReply(chatId: string, text: string) {
  const chat = activeChats.get(chatId);
  if (!chat || chat.mode !== "bot") return;

  const normalized = text.toLowerCase();

  // Check if user requested human agent
  if (normalized === "agent" || normalized.includes("talk to human") || normalized.includes("speak to human") || normalized.includes("human support")) {
    // Set requesting human flag
    chat.requestingHuman = true;
    
    // Emit human support requested event
    emitToDashboard("human_support_requested", { chatId });
    
    await sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.");
    console.log(`🙋 Human support requested for chat ${chatId}`);
    return;
  }

  // Try keyword-based auto reply
  const matchedReply = getAutoReply(text);
  if (matchedReply) {
    await sendBotMessage(chatId, matchedReply);
    return;
  }

  // Default fallback
  await sendBotMessage(
    chatId,
    "🤖 I'm not sure I understand. You can ask about prices, support, or type *agent* for human help."
  );
}

// Handle incoming Telegram messages (only if bot is enabled)
if (bot) {
  bot.on("message", async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text || "";
    const firstName = msg.from?.first_name || "";
    const lastName = msg.from?.last_name || "";
    const from = `${firstName} ${lastName}`.trim();

    console.log(`📨 Telegram message from ${from} (${chatId}): ${text}`);

    // Ensure chat exists with user credentials
    if (!activeChats.has(chatId)) {
      activeChats.set(chatId, { 
        mode: "bot", 
        messages: [],
        source: "telegram",
        userFirstName: firstName,
        userLastName: lastName
      });
      console.log(`✨ New Telegram chat created: ${chatId} (${from})`);
    } else {
      // Update user credentials if they changed
      const chat = activeChats.get(chatId)!;
      chat.userFirstName = firstName;
      chat.userLastName = lastName;
    }

    const chatState = activeChats.get(chatId)!;

    // Store user message
    const userMessage: Message = {
      from: "user",
      text,
      timestamp: Date.now()
    };
    storeMessage(chatId, userMessage);

    // Forward message to dashboard
    emitToDashboard("message_from_user", {
      chatId,
      text,
      from,
      raw: msg
    });

    // If in human mode, don't auto-reply
    if (chatState.mode === "human") {
      console.log(`👤 Telegram chat ${chatId} is in human mode`);
      return;
    }

    // Bot auto-reply
    await handleBotReply(chatId, text);
  });
}

// HTTP endpoints for dashboard actions

// Send message to user (agent message)
app.post("/send", async (req, res) => {
  const { chatId, message, agentId, agentName } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: "Missing chatId or message" });
  }

  const chat = activeChats.get(chatId);

  try {
    // Send via Telegram if it's a Telegram chat
    if (chat?.source === "telegram" && bot) {
      await bot.sendMessage(chatId, message);
    }
    
    // Store and emit agent message
    const agentMessage: Message = {
      from: "agent",
      text: message,
      timestamp: Date.now(),
      agentId,
      agentName
    };
    storeMessage(chatId, agentMessage);
    
    emitToDashboard("message_from_agent", { chatId, message, agentId, agentName });
    console.log(`👨‍💼 Agent ${agentName || agentId} sent message to ${chatId}`);
    
    return res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send message:", err);
    return res.status(500).json({ error: "Failed to send message" });
  }
});

// Takeover chat: switch chat to human mode
app.post("/takeover", async (req, res) => {
  const { chatId, agentId, agentName } = req.body;
  if (!chatId || !agentId) {
    return res.status(400).json({ error: "Missing chatId or agentId" });
  }

  const chat = activeChats.get(String(chatId));
  
  // CRITICAL: Ensure chat session exists in database before takeover
  if (chat?.userId && supabase) {
    try {
      const { data: existing } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('id', chatId)
        .single();

      if (!existing) {
        const { error } = await (supabase.from('chat_sessions') as any).insert({
          id: chatId,
          user_id: chat.userId,
          mode: 'bot', // Will be updated below
          requesting_human: false
        });
        
        if (error) {
          console.error(`❌ Failed to create chat session before takeover:`, error);
        } else {
          console.log(`💾 Created chat session in database before takeover: ${chatId}`);
        }
      }
    } catch (error) {
      console.error(`❌ Exception ensuring chat session before takeover:`, error);
    }
  }
  
  if (chat) {
    const previousMode = chat.mode;
    chat.mode = "human";
    chat.agentId = agentId;
    chat.agentName = agentName;
    chat.requestingHuman = false; // Clear request flag when agent takes over
    
    // Add system message when agent connects
    if (previousMode === "bot" && agentName) {
      const systemMessage: Message = {
        from: "system",
        text: `${agentName} connected`,
        timestamp: Date.now()
      };
      storeMessage(String(chatId), systemMessage, chat.userId);
    }
    
    // Update database session
    if (chat.userId && supabase) {
      try {
        await (supabase.from('chat_sessions') as any)
          .update({
            mode: 'human',
            agent_id: agentId,
            requesting_human: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', chatId);
        console.log(`💾 Updated chat session in database for takeover: ${chatId}`);
      } catch (error) {
        console.error(`❌ Failed to update chat session in database:`, error);
      }
    }
  } else {
    activeChats.set(String(chatId), { 
      mode: "human", 
      agentId,
      agentName,
      messages: [],
      source: "web",
      requestingHuman: false
    });
    
    // Create database session for new chats
    if (supabase) {
      try {
        await (supabase.from('chat_sessions') as any).insert({
          id: String(chatId),
          user_id: agentId, // Use agentId as fallback if no userId
          mode: 'human',
          agent_id: agentId,
          requesting_human: false
        });
        console.log(`💾 Created new chat session in database: ${chatId}`);
      } catch (error) {
        console.error(`❌ Failed to create new chat session:`, error);
      }
    }
  }
  
  emitToDashboard("chat_mode_changed", { 
    chatId: String(chatId), 
    mode: "human", 
    agentId,
    agentName
  });
  
  console.log(`🔧 Agent ${agentName || agentId} took over chat ${chatId}`);
  return res.json({ ok: true });
});

// Release chat: return to bot mode
app.post("/release", async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) {
    return res.status(400).json({ error: "Missing chatId" });
  }

  const chat = activeChats.get(String(chatId));
  if (chat) {
    chat.mode = "bot";
    delete chat.agentId;
    delete chat.agentName;
    chat.requestingHuman = false;
    
    // Update database session
    if (chat.userId && supabase) {
      try {
        await (supabase.from('chat_sessions') as any)
          .update({
            mode: 'bot',
            agent_id: null,
            agent_name: null,
            requesting_human: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', chatId);
        console.log(`💾 Updated chat session in database for release: ${chatId}`);
      } catch (error) {
        console.error(`❌ Failed to update chat session in database:`, error);
      }
    }
  }
  
  emitToDashboard("chat_mode_changed", { 
    chatId: String(chatId), 
    mode: "bot" 
  });
  
  console.log(`🔓 Chat ${chatId} released back to bot`);
  return res.json({ ok: true });
});

// Simple health route
app.get("/health", (req, res) => res.json({ ok: true }));

// Get or create chat session
app.post("/api/chat/session", async (req, res) => {
  const { chatId, userId } = req.body;
  
  if (!chatId || !userId) {
    return res.status(400).json({ error: "Missing chatId or userId" });
  }

  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    // Check if session exists
    const { data: existing } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('id', chatId)
      .single();

    if (existing) {
      return res.json({ session: existing, created: false });
    }

    // Create new session with empty chat_history
    const { data: newSession, error } = await (supabase
      .from('chat_sessions') as any)
      .insert({
        id: chatId,
        user_id: userId,
        mode: 'bot',
        requesting_human: false
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({ session: newSession, created: true });
  } catch (error: any) {
    console.error("Failed to create/get chat session:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Load chat history
app.get("/api/chat/history/:chatId", async (req, res) => {
  const { chatId } = req.params;

  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const messages = await loadChatHistoryFromDatabase(chatId);
    return res.json({ messages });
  } catch (error: any) {
    console.error("Failed to load chat history:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Get user's chat sessions
app.get("/api/chat/sessions/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const { data: sessions, error } = await supabase
      .from('chat_sessions')
      .select('id, created_at, updated_at, mode')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    // Get last message for each session from chat_history JSONB
    const sessionsWithLastMessage = await Promise.all(
      (sessions || []).map(async (session: any) => {
        const { data: chatMessages } = await supabase
          .from('chat_messages')
          .select('chat_history')
          .eq('chat_id', session.id)
          .maybeSingle();

        const history = (chatMessages as any)?.chat_history || [];
        const lastMessage = history.length > 0 ? history[history.length - 1] : null;

        return {
          ...session,
          lastMessage: lastMessage?.text || 'No messages yet'
        };
      })
    );

    return res.json({ sessions: sessionsWithLastMessage });
  } catch (error: any) {
    console.error("Failed to load chat sessions:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Backfill active chats to database (for migration purposes)
app.post("/api/chat/backfill", async (req, res) => {
  const { userId } = req.body;

  if (!supabase || !userId) {
    return res.status(400).json({ error: "Missing userId or database not configured" });
  }

  try {
    let backfilledCount = 0;
    const errors: string[] = [];

    // Find all chats for this user in memory
    for (const [chatId, chatState] of activeChats.entries()) {
      if (chatState.userId === userId || chatId.includes(userId)) {
        console.log(`🔄 Backfilling chat ${chatId} for user ${userId}`);
        
        try {
          // Check if session already exists
          const { data: existing } = await supabase
            .from('chat_sessions')
            .select('id')
            .eq('id', chatId)
            .single();

          if (!existing) {
            // Create session if needed
            await supabase.from('chat_sessions').insert({
              id: chatId,
              user_id: userId,
              mode: chatState.mode || 'bot',
              requesting_human: chatState.requestingHuman || false
            } as any);
          }

          const { data: existingMessagesRow, error: existingMessagesError } = await supabase
            .from('chat_messages' as any)
            .select('id, chat_history, agent_id')
            .eq('chat_id', chatId)
            .maybeSingle();

          if (existingMessagesError) {
            throw existingMessagesError;
          }

          const history = chatState.messages || [];
          if (history.length === 0) {
            continue;
          }

          const historyRow = existingMessagesRow as { id: string; agent_id?: string | null } | null;

          if (!historyRow) {
            await (supabase.from('chat_messages') as any).insert({
              chat_id: chatId,
              agent_id: chatState.agentId || null,
              chat_history: history
            } as any);
          } else {
            await (supabase
              .from('chat_messages') as any)
              .update({
                chat_history: history,
                agent_id: chatState.agentId || historyRow.agent_id || null,
                updated_at: new Date().toISOString()
              } as any)
              .eq('id', historyRow.id);
          }

          backfilledCount++;
          console.log(`✅ Backfilled chat ${chatId} with ${history.length} messages`);
        } catch (err: any) {
          console.error(`❌ Failed to backfill chat ${chatId}:`, err);
          errors.push(`${chatId}: ${err.message}`);
        }
      }
    }

    return res.json({ 
      ok: true, 
      backfilledCount, 
      totalActiveChats: activeChats.size,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: any) {
    console.error("Failed to backfill chats:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Socket.io: support dashboard AND web user connections
// Supported events:
// FROM CLIENT:
//   - user_info: Update user profile (firstName, lastName, userId)
//   - user_message: Send message from web user (with userId for persistence)
//   - request_human: Request human support (alternative name)
//   - request_human_support: Request human support
//   - send_message: Send message as agent
//   - takeover: Agent takes over chat
//   - release: Release chat back to bot
// TO CLIENT:
//   - active_chats_snapshot: Full chat state on connection
//   - message_from_user: User sent a message
//   - message_from_agent: Agent sent a message
//   - bot_message: Bot sent a message
//   - chat_mode_changed: Chat mode changed (bot/human)
//   - human_support_requested: User requested human support
//   - error: Error occurred
// 
// HTTP ENDPOINTS:
//   - POST /api/chat/session: Create or get chat session
//   - GET /api/chat/history/:chatId: Load chat history
//   - GET /api/chat/sessions/:userId: Get user's chat sessions
io.on("connection", (socket) => {
  console.log("✅ Client connected", socket.id);

  // Send current activeChats WITH message history and user credentials
  const snapshot = Array.from(activeChats.entries()).map(([chatId, state]) => ({
    chatId,
    mode: state.mode,
    agentId: state.agentId,
    agentName: state.agentName,
    messages: state.messages,
    source: state.source,
    requestingHuman: state.requestingHuman,
    userFirstName: state.userFirstName,
    userLastName: state.userLastName
  }));
  
  socket.emit("active_chats_snapshot", snapshot);
  console.log(`📸 Sent snapshot of ${snapshot.length} chats`);

  // Handle WEB USER MESSAGES (from UserChat component)
  socket.on("user_message", async ({ chatId, text, userFirstName, userLastName, userId }: { 
    chatId: string; 
    text: string; 
    userFirstName?: string; 
    userLastName?: string;
    userId?: string;
  }) => {
    console.log(`📨 Web user message from ${chatId}: ${text}`, { userFirstName, userLastName, userId });

    // Ensure chat exists with user credentials
    if (!activeChats.has(chatId)) {
      activeChats.set(chatId, {
        mode: "bot",
        messages: [],
        source: "web",
        userFirstName,
        userLastName,
        userId
      });
      console.log(`✨ New web chat created: ${chatId}${userFirstName ? ` (${userFirstName} ${userLastName || ''})` : ''}`);
      
      // CRITICAL: Create session in database if userId provided - BLOCKING
      if (userId && supabase) {
        try {
          const { data: existing } = await supabase
            .from('chat_sessions')
            .select('id')
            .eq('id', chatId)
            .single();

          if (!existing) {
          const { error } = await (supabase.from('chat_sessions') as any).insert({
            id: chatId,
            user_id: userId,
            mode: 'bot',
            requesting_human: false
          });            if (error) {
              console.error(`❌ Failed to create chat session in database:`, error);
            } else {
              console.log(`💾 Created chat session in database: ${chatId}`);
            }
          } else {
            console.log(`💾 Chat session already exists in database: ${chatId}`);
          }
        } catch (error) {
          console.error(`❌ Exception creating chat session in database:`, error);
        }
      }
      
      // Notify all dashboards about new chat
      emitToDashboard("chat_mode_changed", {
        chatId,
        mode: "bot",
        userFirstName,
        userLastName
      });
    } else {
      // Update user credentials if provided
      const chat = activeChats.get(chatId)!;
      if (userFirstName) chat.userFirstName = userFirstName;
      if (userLastName) chat.userLastName = userLastName;
      if (userId) chat.userId = userId;
      
      // Ensure database session exists even for existing chats
      if (userId && supabase) {
        try {
          const { data: existing } = await supabase
            .from('chat_sessions')
            .select('id')
            .eq('id', chatId)
            .single();

          if (!existing) {
            const { error } = await (supabase.from('chat_sessions') as any).insert({
              id: chatId,
              user_id: userId,
              mode: chat.mode,
              requesting_human: chat.requestingHuman || false
            });
            
            if (error) {
              console.error(`❌ Failed to create chat session in database:`, error);
            } else {
              console.log(`💾 Created missing chat session in database: ${chatId}`);
            }
          }
        } catch (error) {
          console.error(`❌ Exception ensuring chat session in database:`, error);
        }
      }
    }

    const chat = activeChats.get(chatId)!;

    // Store user message
    const userMessage: Message = {
      from: "user",
      text,
      timestamp: Date.now()
    };
    storeMessage(chatId, userMessage, userId);

    // Broadcast to all clients (including dashboards)
    emitToDashboard("message_from_user", { 
      chatId, 
      text,
      from: chat.userFirstName ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim() : undefined
    });

    // If in human mode, don't auto-reply
    if (chat.mode === "human") {
      console.log(`👤 Web chat ${chatId} is in human mode`);
      return;
    }

    // Bot auto-reply
    await handleBotReply(chatId, text);
  });

  // Handle user info updates (from UserChat component)
  socket.on("user_info", ({ chatId, firstName, lastName, userId }: { 
    chatId: string; 
    firstName?: string; 
    lastName?: string;
    userId?: string;
  }) => {
    console.log(`👤 User info update for ${chatId}:`, { firstName, lastName, userId });
    
    const chat = activeChats.get(chatId);
    if (chat) {
      if (firstName) chat.userFirstName = firstName;
      if (lastName) chat.userLastName = lastName;
      if (userId) chat.userId = userId;
      
      // Broadcast updated chat state to all clients with user info
      emitToDashboard("chat_mode_changed", {
        chatId,
        mode: chat.mode,
        agentId: chat.agentId,
        agentName: chat.agentName,
        userFirstName: chat.userFirstName,
        userLastName: chat.userLastName,
        requestingHuman: chat.requestingHuman
      });
    } else {
      // Create chat if it doesn't exist
      activeChats.set(chatId, {
        mode: "bot",
        messages: [],
        source: "web",
        userFirstName: firstName,
        userLastName: lastName,
        userId
      });
      
      emitToDashboard("chat_mode_changed", {
        chatId,
        mode: "bot",
        userFirstName: firstName,
        userLastName: lastName
      });
    }
  });

  // Handle explicit human support request from web user (request_human_support)
  socket.on("request_human_support", ({ chatId }: { chatId: string }) => {
    console.log(`🙋 Explicit human support request from ${chatId}`);
    
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard("human_support_requested", { chatId });
      
      // Send confirmation message
      sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.");
    }
  });

  // Handle human support request (alternative event name: request_human)
  socket.on("request_human", ({ chatId }: { chatId: string }) => {
    console.log(`🙋 Human support requested from ${chatId} (via request_human)`);
    
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard("human_support_requested", { chatId });
      
      // Send confirmation message
      sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.");
    }
  });

  // Dashboard sends message via socket
  socket.on("send_message", async ({ chatId, message, agentId, agentName }) => {
    const chat = activeChats.get(String(chatId));
    
    try {
      // Send via Telegram if it's a Telegram chat
      if (chat?.source === "telegram" && bot) {
        await bot.sendMessage(String(chatId), message);
      }
      
      // Store and emit agent message
      const agentMessage: Message = {
        from: "agent",
        text: message,
        timestamp: Date.now(),
        agentId,
        agentName
      };
      storeMessage(String(chatId), agentMessage, chat?.userId);
      
      emitToDashboard("message_from_agent", { chatId, message, agentId, agentName });
      console.log(`👨‍💼 Agent ${agentName || agentId} sent message via socket to ${chatId}`);
    } catch (err) {
      console.error("Failed to send via socket", err);
      socket.emit("error", { message: "send_failed" });
    }
  });

  socket.on("takeover", async ({ chatId, agentId, agentName }) => {
    const chat = activeChats.get(String(chatId));
    
    // CRITICAL: Ensure chat session exists in database before takeover
    if (chat?.userId && supabase) {
      try {
        const { data: existing } = await supabase
          .from('chat_sessions')
          .select('id')
          .eq('id', chatId)
          .single();

        if (!existing) {
          const { error } = await (supabase.from('chat_sessions') as any).insert({
            id: chatId,
            user_id: chat.userId,
            mode: 'bot', // Will be updated below
            requesting_human: false
          });
          
          if (error) {
            console.error(`❌ Failed to create chat session before takeover:`, error);
          } else {
            console.log(`💾 Created chat session in database before takeover: ${chatId}`);
          }
        }
      } catch (error) {
        console.error(`❌ Exception ensuring chat session before takeover:`, error);
      }
    }
    
    if (chat) {
      const previousMode = chat.mode;
      chat.mode = "human";
      chat.agentId = agentId;
      chat.agentName = agentName;
      chat.requestingHuman = false; // Clear request flag when agent takes over
      
      // Add system message when agent connects
      if (previousMode === "bot" && agentName) {
        const systemMessage: Message = {
          from: "system",
          text: `${agentName} connected`,
          timestamp: Date.now()
        };
        storeMessage(String(chatId), systemMessage, chat.userId);
      }
      
      // Update database session
      if (chat.userId && supabase) {
        try {
          await (supabase.from('chat_sessions') as any)
            .update({
              mode: 'human',
              agent_id: agentId,
              agent_name: agentName,
              requesting_human: false,
              updated_at: new Date().toISOString()
            })
            .eq('id', chatId);
          console.log(`💾 Updated chat session in database for takeover: ${chatId}`);
        } catch (error) {
          console.error(`❌ Failed to update chat session in database:`, error);
        }
      }
    } else {
      activeChats.set(String(chatId), { 
        mode: "human", 
        agentId,
        agentName,
        messages: [],
        source: "web",
        requestingHuman: false
      });
    }
    
    emitToDashboard("chat_mode_changed", { 
      chatId: String(chatId), 
      mode: "human", 
      agentId,
      agentName
    });
    console.log(`🔧 Agent ${agentName || agentId} took over chat ${chatId} via socket`);
  });

  socket.on("release", async ({ chatId }) => {
    const chat = activeChats.get(String(chatId));
    if (chat) {
      chat.mode = "bot";
      delete chat.agentId;
      delete chat.agentName;
      chat.requestingHuman = false; // Clear request flag when released
      
      // Update database session
      if (chat.userId && supabase) {
        try {
          await (supabase.from('chat_sessions') as any)
            .update({
              mode: 'bot',
              agent_id: null,
              agent_name: null,
              requesting_human: false,
              updated_at: new Date().toISOString()
            })
            .eq('id', chatId);
          console.log(`💾 Updated chat session in database for release: ${chatId}`);
        } catch (error) {
          console.error(`❌ Failed to update chat session in database:`, error);
        }
      }
    }
    
    emitToDashboard("chat_mode_changed", { 
      chatId: String(chatId), 
      mode: "bot" 
    });
    console.log(`🔓 Chat ${chatId} released via socket`);
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  if (ENABLE_TELEGRAM) {
    console.log(`📱 Telegram bot started and polling...`);
  } else {
    console.log(`💬 Web-only chat mode (no Telegram bot)`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  if (bot) bot.stopPolling();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (bot) bot.stopPolling();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});