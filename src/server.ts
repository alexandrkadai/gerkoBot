import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
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

console.log("💬 Using Telegram-only storage (no database)");

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
const userChatMap = new Map<number, string>(); // Telegram user ID → current chat ID

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

// Message storage is now in-memory only via activeChats Map
// All messages are stored in the ChatState.messages array

// Helper to emit chat event to dashboard
function emitToDashboard(event: string, payload: any) {
  io.emit(event, payload);
}

// Helper to store message in chat history (in-memory only)
function storeMessage(chatId: string, message: Message, userId?: string) {
  const chat = activeChats.get(chatId);
  if (chat) {
    chat.messages.push(message);
    console.log(`💾 Stored message in memory for chat ${chatId}`);
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

    // Generate a unique chat ID for each new user or get existing one
    let chatId = userChatMap.get(telegramUserId);
    
    if (!chatId || !activeChats.has(chatId)) {
      // Create new chat for this user
      chatId = `tg_${telegramUserId}_${Date.now()}`;
      userChatMap.set(telegramUserId, chatId);
      
      activeChats.set(chatId, {
        mode: "bot",
        messages: [],
        source: "telegram",
        userFirstName: firstName,
        userLastName: lastName,
        userId: String(telegramUserId),
        telegramUserId: telegramUserId
      });
      
      console.log(`✨ New Telegram chat created: ${chatId} for user ${from}`);
      
      // Notify dashboard about new chat
      emitToDashboard("chat_mode_changed", {
        chatId,
        mode: "bot",
        userFirstName: firstName,
        userLastName: lastName
      });
    } else {
      // Update user info if changed
      const chat = activeChats.get(chatId)!;
      chat.userFirstName = firstName;
      chat.userLastName = lastName;
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
app.post("/telegram/support/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const telegramId = message.from.id;
    const text = message.text ?? "";
    const agentName = `${message.from.first_name ?? "Agent"}`;

    // 1. Register agent
    if (text === "/start") {

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
      const chats = Array.from(activeChats.entries());
      
      if (chats.length === 0) {
        await tgSend(supportBotUrl, telegramId, "No active chats.");
        return res.sendStatus(200);
      }

      let msg = "📂 <b>Active chats:</b>\n\n";
      for (const [chatId, chat] of chats) {
        const requestFlag = chat.requestingHuman ? "🙋 " : "";
        const modeIcon = chat.mode === "human" ? "👤" : "🤖";
        const userName = `${chat.userFirstName || ''} ${chat.userLastName || ''}`.trim() || chat.userId || 'Unknown';
        msg += `${requestFlag}${modeIcon} <code>${chatId}</code> — ${userName}\n`;
      }

      await tgSend(supportBotUrl, telegramId, msg);
      return res.sendStatus(200);
    }

    // 3. Open chat (takeover)if (text.startsWith("/open")) {
  const parts = text.split(" ");
  const chatId = parts[1];

  if (!chatId) {
    await tgSend(supportBotUrl, telegramId, "Usage: /open <chat_id>");
    return res.sendStatus(200);
  }

  // Save active chat for agent
  agentChatMap.set(telegramId, chatId);

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

  // Notify dashboard
  emitToDashboard("chat_mode_changed", {
    chatId,
    mode: "human",
    agentId: String(telegramId),
    agentName
  });

  // ---------- NEW PART: SEND CHAT HISTORY ----------
  if (chat) {
    if (chat.messages.length === 0) {
      await tgSend(supportBotUrl, telegramId, "📭 Chat is empty. No messages yet.");
    } else {
      await tgSend(supportBotUrl, telegramId, `📜 Chat history for <code>${chatId}</code>:`);

      for (const msg of chat.messages.slice(-30)) {  // last 30 messages
        const author =
          msg.from === "user" ? "🧑 User" :
          msg.from === "agent" ? "👨‍💼 Agent" :
          msg.from === "bot" ? "🤖 Bot" :
          "⚙️ System";

        await tgSend(
          supportBotUrl,
          telegramId,
          `${author}:\n${msg.text}`
        );
      }
    }
  }
  // --------------------------------------------------

 
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
  }
  
  emitToDashboard("chat_mode_changed", { 
    chatId: String(chatId), 
    mode: "bot" 
  });
  
  console.log(`🔓 Chat ${chatId} released back to bot`);
  return res.json({ ok: true });
});

// Get or create chat session (in-memory only)
app.post("/api/chat/session", async (req, res) => {
  const { chatId, userId } = req.body;
  
  if (!chatId || !userId) {
    return res.status(400).json({ error: "Missing chatId or userId" });
  }

  try {
    let chat = activeChats.get(chatId);
    let created = false;
    
    if (!chat) {
      // Create new chat session in memory
      activeChats.set(chatId, {
        mode: "bot",
        messages: [],
        source: "web",
        userId: userId,
        requestingHuman: false
      });
      created = true;
      console.log(`✨ New web chat session created: ${chatId}`);
    }
    
    chat = activeChats.get(chatId)!;
    
    return res.json({ 
      session: {
        id: chatId,
        user_id: userId,
        mode: chat.mode,
        requesting_human: chat.requestingHuman,
        source: chat.source
      }, 
      created 
    });
  } catch (error: any) {
    console.error("Failed to create/get chat session:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Load chat history (from memory)
app.get("/api/chat/history/:chatId", async (req, res) => {
  const { chatId } = req.params;

  try {
    const chat = activeChats.get(chatId);
    const messages = chat?.messages || [];
    return res.json({ messages });
  } catch (error: any) {
    console.error("Failed to load chat history:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Get user's chat sessions (from memory)
app.get("/api/chat/sessions/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const sessions: any[] = [];
    
    for (const [chatId, chat] of activeChats.entries()) {
      if (chat.userId === userId) {
        const lastMessage = chat.messages.length > 0 
          ? chat.messages[chat.messages.length - 1] 
          : null;
        
        sessions.push({
          id: chatId,
          mode: chat.mode,
          source: chat.source,
          lastMessage: lastMessage?.text || 'No messages yet',
          messageCount: chat.messages.length
        });
      }
    }

    return res.json({ sessions });
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
      // Create new chat for web user
      activeChats.set(chatId, {
        mode: "bot",
        messages: [],
        source: "web",
        userFirstName,
        userLastName,
        userId
      });
      
      console.log(`✨ New web chat created: ${chatId} for user ${userFirstName} ${userLastName}`);
      
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

