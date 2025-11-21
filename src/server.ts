import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import http from "http";
import { Server as IOServer } from "socket.io";
import cors from "cors";
import { getAutoReply } from "./getAutoReplies.js";

dotenv.config();

const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:8080";
const WEBHOOK_URL = process.env.BACKEND_URL || "https://gerkobot.onrender.com";

// Load Telegram tokens
const TELEGRAM_CUSTOMER_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_SUPPORT_TOKEN = process.env.TELEGRAM_BOT_SUPPORT_TOKEN!;

const customerBotUrl = `https://api.telegram.org/bot${TELEGRAM_CUSTOMER_TOKEN}`;
const supportBotUrl = `https://api.telegram.org/bot${TELEGRAM_SUPPORT_TOKEN}`;

// Initialize Supabase client
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

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
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST"]
  }
});

// =====================================================
// TYPES & STATE
// =====================================================
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
  requestingHuman?: boolean;
  userFirstName?: string;
  userLastName?: string;
  userId?: string;
  telegramUserId?: number; // Telegram user ID for customer bot
}

const activeChats = new Map<string, ChatState>();
const agentChatMap = new Map<number, string>(); // agent telegram ID → active chat ID

// =====================================================
// UTIL
// =====================================================
async function tgSend(botUrl: string, chatId: number | string, text: string) {
  try {
    await axios.post(`${botUrl}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error(`Failed to send Telegram message to ${chatId}:`, error);
  }
}

async function appendMessage(chatId: string, msg: any) {
  if (!supabase) return;

  try {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, chat_history")
      .eq("chat_id", chatId)
      .eq("archived", false)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      // Create new chat_messages entry
      await (supabase.from('chat_messages') as any).insert({
        chat_id: chatId,
        chat_history: [msg]
      });
      console.log(`💾 Created chat_messages row with initial message: ${chatId}`);
    } else {
      const updated = [...(data as any).chat_history, msg];
      await (supabase.from('chat_messages') as any)
        .update({ chat_history: updated, updated_at: new Date().toISOString() })
        .eq("id", (data as any).id);
      console.log(`💾 Appended message to chat_history for chat ${chatId}`);
    }
  } catch (error) {
    console.error(`❌ Failed to append message:`, error);
  }
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
    
    // Save to database asynchronously (always save if Supabase is configured)
    appendMessage(chatId, message).catch(err => {
      console.error(`❌ Error saving message to database:`, err);
    });
  }
}

// Helper to send bot message
async function sendBotMessage(chatId: string, text: string, source: "web" | "telegram" = "web") {
  const chat = activeChats.get(chatId);
  
  // Send via customer Telegram bot if it's a Telegram chat
  if (source === "telegram" && chat?.telegramUserId) {
    await tgSend(customerBotUrl, chat.telegramUserId, text);
  }
  
  // Store and emit bot message
  const message: Message = {
    from: "bot",
    text,
    timestamp: Date.now()
  };
  
  storeMessage(chatId, message, chat?.userId);
  emitToDashboard("bot_message", { chatId, text });
  
  console.log(`🤖 Bot sent message to ${chatId}: ${text}`);
}

// Bot auto-reply logic
async function handleBotReply(chatId: string, text: string, source: "web" | "telegram" = "web") {
  const chat = activeChats.get(chatId);
  if (!chat || chat.mode !== "bot") return;

  const normalized = text.toLowerCase();

  // Check if user requested human agent
  if (normalized === "agent" || normalized.includes("talk to human") || 
      normalized.includes("speak to human") || normalized.includes("human support")) {
    chat.requestingHuman = true;
    emitToDashboard("human_support_requested", { chatId });
    await sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.", source);
    console.log(`🙋 Human support requested for chat ${chatId}`);
    return;
  }

  // Try keyword-based auto reply
  const matchedReply = getAutoReply(text);
  if (matchedReply) {
    await sendBotMessage(chatId, matchedReply, source);
    return;
  }

  // Default fallback
  await sendBotMessage(
    chatId,
    "🤖 I'm not sure I understand. You can ask about prices, support, or type *agent* for human help.",
    source
  );
}

// =====================================================
// =============== CUSTOMER BOT WEBHOOK =================
// =====================================================
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const telegramUserId = message.from.id;
    const text = message.text ?? "";
    const firstName = message.from?.first_name || "";
    const lastName = message.from?.last_name || "";
    const from = `${firstName} ${lastName}`.trim();

    console.log(`📨 Telegram customer message from ${from} (${telegramUserId}): ${text}`);

    if (!supabase) {
      console.error("❌ Supabase not configured");
      return res.sendStatus(200);
    }

    // 1. Find or create chat session
    let chatSession = await supabase
      .from("chat_sessions")
      .select("*")
      .eq("user_id", String(telegramUserId))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let chatId: string;

    if (chatSession.error || !chatSession.data) {
      const created = await (supabase
        .from("chat_sessions") as any)
        .insert({
          user_id: String(telegramUserId),
          mode: "bot",
          requesting_human: false
        })
        .select()
        .single();
      
      chatId = created.data.id;
      console.log(`✨ New Telegram chat session created: ${chatId}`);
    } else {
      chatId = (chatSession.data as any).id;
    }

    // Ensure chat exists in active chats
    if (!activeChats.has(chatId)) {
      activeChats.set(chatId, {
        mode: "bot",
        messages: [],
        source: "telegram",
        userFirstName: firstName,
        userLastName: lastName,
        userId: String(telegramUserId),
        telegramUserId: telegramUserId
      });
      console.log(`✨ New Telegram active chat: ${chatId} (${from})`);
    } else {
      const chat = activeChats.get(chatId)!;
      chat.userFirstName = firstName;
      chat.userLastName = lastName;
      chat.telegramUserId = telegramUserId;
    }

    const chatState = activeChats.get(chatId)!;

    // 2. Store user message
    const userMessage: Message = {
      from: "user",
      text,
      timestamp: Date.now()
    };
    storeMessage(chatId, userMessage, String(telegramUserId));

    // 3. Forward to dashboard
    emitToDashboard("message_from_user", {
      chatId,
      text,
      from,
      raw: message
    });

    // 4. If in human mode, forward to support agent via support bot
    if (chatState.mode === "human" && chatState.agentId) {
      const agentTelegramId = parseInt(chatState.agentId);
      if (!isNaN(agentTelegramId)) {
        await tgSend(
          supportBotUrl,
          agentTelegramId,
          `💬 Message from <b>${from}</b> (Chat: <code>${chatId}</code>):\n\n${text}`
        );
      }
      console.log(`👤 Telegram chat ${chatId} is in human mode - forwarded to agent`);
      return res.sendStatus(200);
    }

    // 5. Bot auto-reply
    await handleBotReply(chatId, text, "telegram");

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Customer webhook error:", e);
    res.sendStatus(200);
  }
});

// =====================================================
// =============== SUPPORT BOT WEBHOOK =================
// =====================================================
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const telegramId = message.from.id;
    const text = message.text ?? "";
    const agentName = `${message.from.first_name ?? "Agent"}`;

    if (!supabase) {
      console.error("❌ Supabase not configured");
      return res.sendStatus(200);
    }

    // 1. Register agent
    if (text === "/start") {
      await (supabase
        .from("support_agents") as any)
        .upsert({
          telegram_id: telegramId,
          name: agentName,
          is_active: true,
        });

      await tgSend(
        supportBotUrl,
        telegramId,
        "👋 Welcome, support agent!\n\n" +
        "Commands:\n" +
        "/list - View active chats\n" +
        "/open <chat_id> - Open a chat\n" +
        "/release - Release current chat\n" +
        "Type messages normally to reply to users."
      );
      return res.sendStatus(200);
    }

    // 2. List active chats
    if (text === "/list") {
      const { data } = await supabase
        .from("chat_sessions")
        .select("id, user_id, mode, requesting_human, updated_at")
        .order("updated_at", { ascending: false })
        .limit(20);

      if (!data || data.length === 0) {
        await tgSend(supportBotUrl, telegramId, "No active chats.");
        return res.sendStatus(200);
      }

      let msg = "📂 <b>Active chats:</b>\n\n";
      for (const c of data as any[]) {
        const requestFlag = c.requesting_human ? "🙋 " : "";
        const modeIcon = c.mode === "human" ? "👤" : "🤖";
        msg += `${requestFlag}${modeIcon} <code>${c.id}</code> — user ${c.user_id}\n`;
      }

      await tgSend(supportBotUrl, telegramId, msg);
      return res.sendStatus(200);
    }

    // 3. Open chat (takeover)
    if (text.startsWith("/open")) {
      const parts = text.split(" ");
      const chatId = parts[1];

      if (!chatId) {
        await tgSend(supportBotUrl, telegramId, "Usage: /open <chat_id>");
        return res.sendStatus(200);
      }

      // Save active chat for agent
      agentChatMap.set(telegramId, chatId);

      // Update chat state to human mode
      const chat = activeChats.get(chatId);
      if (chat) {
        chat.mode = "human";
        chat.agentId = String(telegramId);
        chat.agentName = agentName;
        chat.requestingHuman = false;

        // Add system message
        const systemMessage: Message = {
          from: "system",
          text: `${agentName} connected`,
          timestamp: Date.now()
        };
        storeMessage(chatId, systemMessage);
      }

      // Update database
      await (supabase
        .from('chat_sessions') as any)
        .update({
          mode: 'human',
          requesting_human: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', chatId);

      // Notify dashboard
      emitToDashboard("chat_mode_changed", {
        chatId,
        mode: "human",
        agentId: String(telegramId),
        agentName
      });

      await tgSend(
        supportBotUrl,
        telegramId,
        `✅ Opened chat <code>${chatId}</code>\nYou're now in human mode. Send messages normally.`
      );
      console.log(`🔧 Agent ${agentName} took over chat ${chatId} via Telegram`);
      return res.sendStatus(200);
    }

    // 4. Release chat
    if (text === "/release") {
      const currentChat = agentChatMap.get(telegramId);
      if (!currentChat) {
        await tgSend(supportBotUrl, telegramId, "No chat is currently opened.");
        return res.sendStatus(200);
      }

      agentChatMap.delete(telegramId);

      const chat = activeChats.get(currentChat);
      if (chat) {
        chat.mode = "bot";
        delete chat.agentId;
        delete chat.agentName;
        chat.requestingHuman = false;
      }

      // Update database
      await (supabase
        .from('chat_sessions') as any)
        .update({
          mode: 'bot',
          agent_id: null,
          requesting_human: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', currentChat);

      emitToDashboard("chat_mode_changed", {
        chatId: currentChat,
        mode: "bot"
      });

      await tgSend(supportBotUrl, telegramId, `🔓 Released chat <code>${currentChat}</code>`);
      console.log(`🔓 Chat ${currentChat} released by agent ${agentName}`);
      return res.sendStatus(200);
    }

    // 5. Send message from agent to user
    const currentChat = agentChatMap.get(telegramId);
    if (currentChat) {
      const chat = activeChats.get(currentChat);
      
      if (!chat) {
        await tgSend(supportBotUrl, telegramId, "Chat not found in active chats.");
        return res.sendStatus(200);
      }

      // Save agent message
      const agentMessage: Message = {
        from: "agent",
        text,
        timestamp: Date.now(),
        agentId: String(telegramId),
        agentName
      };
      storeMessage(currentChat, agentMessage);

      // Send to customer via customer bot
      if (chat.telegramUserId) {
        await tgSend(customerBotUrl, chat.telegramUserId, text);
      }

      // Notify dashboard
      emitToDashboard("message_from_agent", {
        chatId: currentChat,
        message: text,
        agentId: String(telegramId),
        agentName
      });

      console.log(`👨‍💼 Agent ${agentName} sent message to ${currentChat}`);
      return res.sendStatus(200);
    }

    // No chat opened
    await tgSend(supportBotUrl, telegramId, "Use /list to view chats or /open <id> to start chatting.");
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Support webhook error:", e);
    res.sendStatus(200);
  }
});

// =====================================================
// HTTP ENDPOINTS FOR DASHBOARD
// =====================================================

// Simple health route
app.get("/health", (req, res) => res.json({ ok: true }));

// Send message to user (agent message)
app.post("/send", async (req, res) => {
  const { chatId, message, agentId, agentName } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: "Missing chatId or message" });
  }

  const chat = activeChats.get(chatId);

  try {
    // Send via customer Telegram bot if it's a Telegram chat
    if (chat?.source === "telegram" && chat.telegramUserId) {
      await tgSend(customerBotUrl, chat.telegramUserId, message);
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
  
  if (chat) {
    const previousMode = chat.mode;
    chat.mode = "human";
    chat.agentId = agentId;
    chat.agentName = agentName;
    chat.requestingHuman = false;
    
    if (previousMode === "bot" && agentName) {
      const systemMessage: Message = {
        from: "system",
        text: `${agentName} connected`,
        timestamp: Date.now()
      };
      storeMessage(String(chatId), systemMessage, chat.userId);
    }
    
    if (supabase) {
      try {
        // Only set agent_id if it's a valid UUID (not a Telegram numeric ID)
        const isUuid = agentId && agentId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        await (supabase.from('chat_sessions') as any)
          .update({
            mode: 'human',
            agent_id: isUuid ? agentId : null,
            requesting_human: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', chatId);
      } catch (error) {
        console.error(`❌ Failed to update chat session:`, error);
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
    
    if (supabase) {
      try {
        await (supabase.from('chat_sessions') as any)
          .update({
            mode: 'bot',
            agent_id: null,
            requesting_human: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', chatId);
      } catch (error) {
        console.error(`❌ Failed to update chat session:`, error);
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
    const { data: existing } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('id', chatId)
      .maybeSingle();

    if (existing) {
      return res.json({ session: existing, created: false });
    }

    const { data: newSession, error } = await (supabase
      .from('chat_sessions') as any)
      .insert({
        id: chatId,
        user_id: userId,
        mode: 'bot',
        requesting_human: false,
        source: 'web'
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
    const { data } = await supabase
      .from('chat_messages')
      .select('chat_history')
      .eq('chat_id', chatId)
      .maybeSingle();

    const messages = ((data as any)?.chat_history || []) as Message[];
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

// =====================================================
// SOCKET.IO CONNECTIONS
// =====================================================
io.on("connection", (socket) => {
  console.log("✅ Client connected", socket.id);

  // Send current activeChats snapshot
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

  // Handle WEB USER MESSAGES
  socket.on("user_message", async ({ chatId, text, userFirstName, userLastName, userId }: { 
    chatId: string; 
    text: string; 
    userFirstName?: string; 
    userLastName?: string;
    userId?: string;
  }) => {
    console.log(`📨 Web user message from ${chatId}: ${text}`);

    if (!activeChats.has(chatId)) {
      activeChats.set(chatId, {
        mode: "bot",
        messages: [],
        source: "web",
        userFirstName,
        userLastName,
        userId
      });
      
      emitToDashboard("chat_mode_changed", {
        chatId,
        mode: "bot",
        userFirstName,
        userLastName
      });
    } else {
      const chat = activeChats.get(chatId)!;
      if (userFirstName) chat.userFirstName = userFirstName;
      if (userLastName) chat.userLastName = userLastName;
      if (userId) chat.userId = userId;
    }

    const chat = activeChats.get(chatId)!;

    const userMessage: Message = {
      from: "user",
      text,
      timestamp: Date.now()
    };
    storeMessage(chatId, userMessage, userId);

    emitToDashboard("message_from_user", { 
      chatId, 
      text,
      from: chat.userFirstName ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim() : undefined
    });

    if (chat.mode === "human") {
      return;
    }

    await handleBotReply(chatId, text, "web");
  });

  // Handle user info updates
  socket.on("user_info", ({ chatId, firstName, lastName, userId }: { 
    chatId: string; 
    firstName?: string; 
    lastName?: string;
    userId?: string;
  }) => {
    const chat = activeChats.get(chatId);
    if (chat) {
      if (firstName) chat.userFirstName = firstName;
      if (lastName) chat.userLastName = lastName;
      if (userId) chat.userId = userId;
      
      emitToDashboard("chat_mode_changed", {
        chatId,
        mode: chat.mode,
        agentId: chat.agentId,
        agentName: chat.agentName,
        userFirstName: chat.userFirstName,
        userLastName: chat.userLastName,
        requestingHuman: chat.requestingHuman
      });
    }
  });

  // Handle human support request
  socket.on("request_human_support", ({ chatId }: { chatId: string }) => {
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard("human_support_requested", { chatId });
      sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.", chat.source);
    }
  });

  socket.on("request_human", ({ chatId }: { chatId: string }) => {
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard("human_support_requested", { chatId });
      sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.", chat.source);
    }
  });

  // Dashboard sends message
  socket.on("send_message", async ({ chatId, message, agentId, agentName }) => {
    const chat = activeChats.get(String(chatId));
    
    try {
      if (chat?.source === "telegram" && chat.telegramUserId) {
        await tgSend(customerBotUrl, chat.telegramUserId, message);
      }
      
      const agentMessage: Message = {
        from: "agent",
        text: message,
        timestamp: Date.now(),
        agentId,
        agentName
      };
      storeMessage(String(chatId), agentMessage, chat?.userId);
      
      emitToDashboard("message_from_agent", { chatId, message, agentId, agentName });
    } catch (err) {
      console.error("Failed to send via socket", err);
      socket.emit("error", { message: "send_failed" });
    }
  });

  // Takeover via socket
  socket.on("takeover", async ({ chatId, agentId, agentName }) => {
    const chat = activeChats.get(String(chatId));
    
    if (chat) {
      const previousMode = chat.mode;
      chat.mode = "human";
      chat.agentId = agentId;
      chat.agentName = agentName;
      chat.requestingHuman = false;
      
      if (previousMode === "bot" && agentName) {
        const systemMessage: Message = {
          from: "system",
          text: `${agentName} connected`,
          timestamp: Date.now()
        };
        storeMessage(String(chatId), systemMessage, chat.userId);
      }
    }
    
    emitToDashboard("chat_mode_changed", { 
      chatId: String(chatId), 
      mode: "human", 
      agentId,
      agentName
    });
  });

  // Release via socket
  socket.on("release", async ({ chatId }) => {
    const chat = activeChats.get(String(chatId));
    if (chat) {
      chat.mode = "bot";
      delete chat.agentId;
      delete chat.agentName;
      chat.requestingHuman = false;
    }
    
    emitToDashboard("chat_mode_changed", { 
      chatId: String(chatId), 
      mode: "bot" 
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected", socket.id);
  });
});

// =====================================================
// SERVER STARTUP
// =====================================================
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🌐 Frontend origin: ${FRONTEND_ORIGIN}`);
  console.log(`📱 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`💬 Two-bot mode: Customer + Support agents via Telegram`);
  console.log(`🔌 Socket.IO enabled for real-time dashboard`);
  console.log(`\n📋 Customer Bot Webhook: ${WEBHOOK_URL}/webhook`);
  console.log(`📋 Support Bot Webhook: ${WEBHOOK_URL}/telegram/support/webhook`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
