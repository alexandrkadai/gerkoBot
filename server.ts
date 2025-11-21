import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT;
app.listen(port, () => {
  console.log("Server running on port " + port);
});

// Load env
const TELEGRAM_CUSTOMER_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_SUPPORT_TOKEN = process.env.TELEGRAM_BOT_SUPPORT_TOKEN!;
const WEBHOOK_URL = process.env.BACKEND_URL!;

const customerBotUrl = `https://api.telegram.org/bot${TELEGRAM_CUSTOMER_TOKEN}`;
const supportBotUrl = `https://api.telegram.org/bot${TELEGRAM_SUPPORT_TOKEN}`;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY! // must be service key
);

// =====================================================
// UTIL
// =====================================================
async function tgSend(botUrl: string, chatId: number | string, text: string) {
  await axios.post(`${botUrl}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  });
}

async function appendMessage(chatId: string, msg: any) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, chat_history")
    .eq("chat_id", chatId)
    .eq("archived", false)
    .single();

  if (error) throw error;

  const updated = [...data.chat_history, msg];

  await supabase
    .from("chat_messages")
    .update({ chat_history: updated })
    .eq("id", data.id);
}

// =====================================================
// =============== CUSTOMER BOT WEBHOOK =================
// =====================================================
app.post("/telegram/customer/webhook", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message) return res.sendStatus(200);

    const telegramUserId = message.from.id;
    const text = message.text ?? "";
    const timestamp = Date.now();

    // 1. Find or create chat session
    let chatSession = await supabase
      .from("chat_sessions")
      .select("*")
      .eq("user_id", telegramUserId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (chatSession.error || !chatSession.data) {
      const created = await supabase
        .from("chat_sessions")
        .insert({
          user_id: telegramUserId,
          mode: "bot",
        })
        .select()
        .single();
      chatSession = created;
    }

    const chatId = chatSession.data.id;

    // 2. Insert message into chat_messages jsonb
    await appendMessage(chatId, {
      from: "user",
      text,
      timestamp,
    });

    // 3. Forward to support bot
    await tgSend(
      supportBotUrl,
      process.env.SUPPORT_GROUP_ID!, // or agent chat id later
      `💬 New message from user <b>${telegramUserId}</b>\nChat ID: <code>${chatId}</code>\n\n${text}`
    );

    // 4. Bot reply to user (optional)
    await tgSend(
      customerBotUrl,
      telegramUserId,
      "🤖 Thanks! Support agent will reply shortly."
    );

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
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

    // 1. Register agent
    if (text === "/start") {
      await supabase
        .from("support_agents")
        .upsert({
          telegram_id: telegramId,
          name: `${message.from.first_name ?? ""}`,
          is_active: true,
        });

      await tgSend(
        supportBotUrl,
        telegramId,
        "👋 Welcome, support agent.\nUse /list to see active chats."
      );
      return res.sendStatus(200);
    }

    // 2. List active chats
    if (text === "/list") {
      const { data } = await supabase
        .from("chat_sessions")
        .select("id, user_id, mode, updated_at")
        .order("updated_at", { ascending: false })
        .limit(20);

      if (!data || data.length === 0) {
        await tgSend(supportBotUrl, telegramId, "No active chats.");
        return res.sendStatus(200);
      }

      let msg = "📂 <b>Active chats:</b>\n\n";
      for (const c of data) {
        msg += `• <b>${c.id}</b> — user ${c.user_id}\n`;
      }

      await tgSend(supportBotUrl, telegramId, msg);
      return res.sendStatus(200);
    }

    // 3. Open chat
    if (text.startsWith("/open")) {
      const parts = text.split(" ");
      const chatId = parts[1];

      if (!chatId) {
        await tgSend(supportBotUrl, telegramId, "Usage: /open <chat_id>");
        return res.sendStatus(200);
      }

      // Save active chat for agent
      agentChatMap.set(telegramId, chatId);

      await tgSend(
        supportBotUrl,
        telegramId,
        `📂 Opened chat <code>${chatId}</code>\nSend messages normally now.`
      );
      return res.sendStatus(200);
    }

    // 4. Send message from agent to user
    const currentChat = agentChatMap.get(telegramId);
    if (currentChat) {
      // Find user's telegram id
      const { data: session } = await supabase
        .from("chat_sessions")
        .select("user_id")
        .eq("id", currentChat)
        .single();

      if (!session) {
        await tgSend(supportBotUrl, telegramId, "Chat not found.");
        return res.sendStatus(200);
      }

      const userTgId = session.user_id;

      // Save message
      await appendMessage(currentChat, {
        from: "agent",
        text,
        timestamp: Date.now(),
      });

      // Send to customer
      await tgSend(customerBotUrl, userTgId, text);

      return res.sendStatus(200);
    }

    // No chat opened
    await tgSend(supportBotUrl, telegramId, "Use /list or /open <id> first.");
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// In-memory map: agent → currently opened chat
const agentChatMap = new Map<number, string>();
