// server.ts — Option A (NO DATABASE)
// Everything is stored inside Telegram threads

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// --------------------------------------------------------
// ENVIRONMENT
// --------------------------------------------------------
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN!;
const SUPPORT_BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN!;
const SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID!; // -100xxxxxxxxxx
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

if (!CUSTOMER_BOT_TOKEN || !SUPPORT_BOT_TOKEN || !SUPPORT_GROUP_ID) {
  console.error("❌ Missing CUSTOMER_BOT_TOKEN, SUPPORT_BOT_TOKEN, SUPPORT_GROUP_ID");
  process.exit(1);
}

// Telegram bot URLs
const TG_CUSTOMER = `https://api.telegram.org/bot${CUSTOMER_BOT_TOKEN}`;
const TG_SUPPORT = `https://api.telegram.org/bot${SUPPORT_BOT_TOKEN}`;

// --------------------------------------------------------
// UTIL — SEND MESSAGE
// --------------------------------------------------------
async function sendMessage(botUrl: string, chatId: number | string, text: string, threadId?: number) {
  try {
    await axios.post(`${botUrl}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      message_thread_id: threadId ?? undefined,
    });
  } catch (e) {
    console.error("❌ sendMessage failed:", e);
  }
}

// --------------------------------------------------------
// MEMORY STORAGE (SERVER RESTART = CLEAN)
// --------------------------------------------------------
interface ChatState {
  userId: number;
  userName: string;
  threadId: number; // Telegram topic contains full history
  mode: "bot" | "human";
}

const chats = new Map<string, ChatState>(); 
// Key = userId (string), Value = ChatState

// --------------------------------------------------------
// CUSTOMER WEBHOOK — USER MESSAGES
// --------------------------------------------------------
app.post("/webhook/customer", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg) return res.sendStatus(200);

    const telegramUserId = msg.from.id;
    const name = `${msg.from.first_name ?? ""} ${msg.from.last_name ?? ""}`.trim();
    const text = msg.text ?? "";

    console.log(`💬 User → Bot: ${name}: ${text}`);

    const key = String(telegramUserId);
    let chat = chats.get(key);

    // ----------------------------------------------------
    // CREATE NEW THREAD IF FIRST MESSAGE
    // ----------------------------------------------------
    if (!chat) {
      const create = await axios.post(`${TG_SUPPORT}/createForumTopic`, {
        chat_id: SUPPORT_GROUP_ID,
        name: `User ${telegramUserId}`,
      });

      const threadId = create.data.result.message_thread_id;

      chat = {
        userId: telegramUserId,
        userName: name,
        threadId,
        mode: "bot",
      };

      chats.set(key, chat);

      console.log(`✨ Created Telegram Topic: ${threadId} for user ${name}`);
    }

    const { threadId } = chat;

    // ----------------------------------------------------
    // STORE MESSAGE in Telegram thread (this is storage)
    // ----------------------------------------------------
    await sendMessage(TG_SUPPORT, SUPPORT_GROUP_ID, `👤 <b>${name}</b>\n${text}`, threadId);

    // ----------------------------------------------------
    // HUMAN MODE → Forward to support
    // ----------------------------------------------------
    if (chat.mode === "human") {
      console.log("👤 Human mode: message forwarded to support");
      return res.sendStatus(200);
    }

    // ----------------------------------------------------
    // BOT MODE → Auto-reply to user
    // ----------------------------------------------------
    const botReply = `🤖 <b>Bot:</b> I received your message: "${text}"`;

    await sendMessage(TG_CUSTOMER, telegramUserId, botReply);
    await sendMessage(TG_SUPPORT, SUPPORT_GROUP_ID, `🤖 Bot → User\n${botReply}`, threadId);

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error in customer webhook", err);
    return res.sendStatus(200);
  }
});

// --------------------------------------------------------
// SUPPORT WEBHOOK — HUMAN AGENT REPLIES
// --------------------------------------------------------
app.post("/webhook/support", async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg || !msg.is_topic_message) return res.sendStatus(200);

    const threadId = msg.message_thread_id;
    const text = msg.text ?? "";
    const agentName = msg.from.first_name;

    // Find which user this thread belongs to
    const chat = [...chats.values()].find((c) => c.threadId === threadId);

    if (!chat) return res.sendStatus(200);

    // Move chat to human mode
    chat.mode = "human";

    console.log(`👨‍💻 Agent → User: ${chat.userName}: ${text}`);

    // Send to user
    await sendMessage(TG_CUSTOMER, chat.userId, `👨‍💻 <b>${agentName}:</b> ${text}`);

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Support webhook error:", e);
    res.sendStatus(200);
  }
});

// --------------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
  console.log("Customer Webhook: POST /webhook/customer");
  console.log("Support Webhook:  POST /webhook/support");
});
