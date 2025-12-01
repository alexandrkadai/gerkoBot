import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { getAutoReply } from './getAutoReplies.js';

dotenv.config();

const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:8080';
const WEBHOOK_URL = process.env.BACKEND_URL || 'https://gerkobot.onrender.com';

// Load Telegram tokens
const TELEGRAM_CUSTOMER_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_SUPPORT_TOKEN = process.env.TELEGRAM_BOT_SUPPORT_TOKEN!;

const customerBotUrl = `https://api.telegram.org/bot${TELEGRAM_CUSTOMER_TOKEN}`;
const supportBotUrl = `https://api.telegram.org/bot${TELEGRAM_SUPPORT_TOKEN}`;

// Initialize Supabase client
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const supabaseKey =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

console.log('💬 Using Telegram-only storage (no database)');
console.log('📦 Supabase Storage initialized for file uploads');

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

// =====================================================
// TYPES & STATE
// =====================================================
interface Message {
  from: 'user' | 'agent' | 'bot' | 'system';
  text: string;
  timestamp: number;
  agentId?: string;
  agentName?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
}

interface ChatState {
  mode: 'bot' | 'human';
  agentId?: string;
  agentName?: string;
  messages: Message[];
  source: 'web' | 'telegram';
  requestingHuman?: boolean;
  userFirstName?: string;
  userLastName?: string;
  userId?: string;
  telegramUserId?: number; // Telegram user ID for customer bot
  createdAt: number;
  lastActivityAt: number;
  visited?: boolean; // Track if chat has been opened by an agent
}

const activeChats = new Map<string, ChatState>();
const agentChatMap = new Map<number, string>(); // agent telegram ID → active chat ID
const userChatMap = new Map<number, string>(); // Telegram user ID → current chat ID
const registeredAgents = new Set<number>(); // Telegram IDs of registered support agents

// =====================================================
// UTIL
// =====================================================
async function tgSend(botUrl: string, chatId: number | string, text: string) {
  try {
    await axios.post(`${botUrl}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (error) {
    console.error(`Failed to send Telegram message to ${chatId}:`, error);
  }
}

// Helper to upload base64 file to Supabase Storage and return public URL
async function uploadFileToSupabase(
  base64Data: string,
  fileName: string,
  fileType: string,
  chatId: string
): Promise<string | null> {
  try {
    // Extract base64 content (remove data:image/jpeg;base64, prefix)
    const base64Content = base64Data.split(',')[1] || base64Data;

    // Convert base64 to buffer
    const buffer = Buffer.from(base64Content, 'base64');

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const uniqueFileName = `${timestamp}_${sanitizedName}`;
    const filePath = `${chatId}/${uniqueFileName}`;
    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from('Chat_Files_Storage')
      .upload(filePath, buffer, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      console.error('❌ Supabase upload error:', error);
      return null;
    }

    // Create signed URL (expires in 60 seconds)
    const { data: signedUrlData, error: signedUrlError } =
      await supabase.storage
        .from('Chat_Files_Storage')
        .createSignedUrl(filePath, 60);

    if (signedUrlError) {
      console.error('❌ Error creating signed URL:', signedUrlError);
      return null;
    }

    console.log(
      `✅ File uploaded to Supabase with signed URL: ${signedUrlData.signedUrl}`
    );
    return signedUrlData.signedUrl;
  } catch (error) {
    console.error('❌ Error uploading to Supabase:', error);
    return null;
  }
}

// Message storage is now in-memory only via activeChats Map
// All messages are stored in the ChatState.messages array

// Helper to emit chat event to dashboard
function emitToDashboard(event: string, payload: any) {
  io.emit(event, payload);
}

// Helper to notify all registered agents about new/updated chats
async function notifyAgents(
  chatId: string,
  message: string,
  isNewChat: boolean = false
) {
  const chat = activeChats.get(chatId);
  if (!chat) {
    console.log(`⚠️ Cannot notify agents - chat ${chatId} not found`);
    return;
  }

  if (registeredAgents.size === 0) {
    console.log(
      `⚠️ No agents registered yet. Use /start in support bot to register.`
    );
    return;
  }

  let orgName = 'Unknown';
  let subStatus = 'Unknown';
  
  // Fetch organization info if userId is available
  if (chat.userId) {
    try {
      // First, get the user's profile to find organization_id
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('organization_id')
        .eq('id', chat.userId)
        .single();
      
      if (!profileError && profile?.organization_id) {
        // Get organization details
        const { data: org, error: orgError } = await supabase
          .from('organization')
          .select('business_name')
          .eq('id', profile.organization_id)
          .single();
        
        if (!orgError && org) {
          orgName = org.business_name || 'Unknown';
          
          // Get subscription status
          const { data: subscription, error: subError } = await supabase
            .from('subscriptions')
            .select('status')
            .eq('organization_id', profile.organization_id)
            .single();
          
          if (!subError && subscription) {
            subStatus = subscription.status || 'Unknown';
          } else if (subError) {
            console.error('Error fetching subscription:', subError);
          }
        } else if (orgError) {
          console.error('Error fetching organization:', orgError);
        }
      } else if (profileError) {
        console.error('Error fetching user profile:', profileError);
      }
    } catch (error) {
      console.error('Error fetching org info:', error);
    }
  }

  const userName = chat.userFirstName
    ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
    : 'Anonymous';
  const sourceIcon = chat.source === 'web' ? '🌐' : '📱';

  const notificationTitle = isNewChat
    ? '🔔 <b>NEW CHAT CREATED!</b>'
    : '💬 <b>New Message</b>';
  const notificationText = `${notificationTitle}\n\n👤 User: ${userName}\n🏢 Organization: ${orgName}\n📊 Subscription: ${subStatus}\n${sourceIcon} Source: ${chat.source}\n\nMessage: "${message}"\n\nClick button to open chat`;

  console.log(
    `📢 Sending ${isNewChat ? 'NEW CHAT' : 'MESSAGE'} notification to ${registeredAgents.size} agents...`
  );

  // Send to all registered agents with inline button
  let successCount = 0;
  for (const agentId of registeredAgents) {
    try {
      await axios.post(`${supportBotUrl}/sendMessage`, {
        chat_id: agentId,
        text: notificationText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📖 Open Chat', callback_data: `open_${chatId}` }],
          ],
        },
      });
      successCount++;
      console.log(`✅ Notification sent to agent ${agentId}`);
    } catch (error) {
      console.error(`❌ Failed to notify agent ${agentId}:`, error);
    }
  }

  console.log(
    `📢 Successfully notified ${successCount}/${registeredAgents.size} agents about ${isNewChat ? 'new chat' : 'message'} ${chatId}`
  );
}

// Helper to store message in chat history (in-memory only)
function storeMessage(chatId: string, message: Message, userId?: string) {
  const chat = activeChats.get(chatId);
  if (chat) {
    chat.messages.push(message);
    chat.lastActivityAt = Date.now();
    console.log(`💾 Stored message in memory for chat ${chatId}`);
  }
}

// Helper to send bot message
async function sendBotMessage(
  chatId: string,
  text: string,
  source: 'web' | 'telegram' = 'web'
) {
  const chat = activeChats.get(chatId);

  // Send via customer Telegram bot if it's a Telegram chat
  if (source === 'telegram' && chat?.telegramUserId) {
    await tgSend(customerBotUrl, chat.telegramUserId, text);
  }

  // Store and emit bot message
  const message: Message = {
    from: 'bot',
    text,
    timestamp: Date.now(),
  };

  storeMessage(chatId, message, chat?.userId);
  emitToDashboard('bot_message', { chatId, text });

  console.log(`🤖 Bot sent message to ${chatId}: ${text}`);
}

// Bot auto-reply logic
async function handleBotReply(
  chatId: string,
  text: string,
  source: 'web' | 'telegram' = 'web'
) {
  const chat = activeChats.get(chatId);
  if (!chat || chat.mode !== 'bot') return;

  const normalized = text.toLowerCase();

  // Check if user requested human agent
  if (
    normalized === 'agent' ||
    normalized.includes('talk to human') ||
    normalized.includes('speak to human') ||
    normalized.includes('human support')
  ) {
    chat.requestingHuman = true;
    emitToDashboard('human_support_requested', { chatId });
    await sendBotMessage(
      chatId,
      "🙋 I've notified our support team. An agent will join you shortly.",
      source
    );

    // Immediately notify all agents
    const userName = chat.userFirstName
      ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
      : 'Anonymous';
    const sourceIcon = chat.source === 'web' ? '🌐' : '📱';

    // Fetch organization and subscription info
    let orgName = 'Unknown';
    let subStatus = 'Unknown';
    if (chat.userId) {
      try {
        // First, get the user's profile to find organization_id
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('organization_id')
          .eq('id', chat.userId)
          .single();
        
        if (!profileError && profile?.organization_id) {
          // Get organization details
          const { data: org, error: orgError } = await supabase
            .from('organization')
            .select('business_name')
            .eq('id', profile.organization_id)
            .single();
          
          if (!orgError && org) {
            orgName = org.business_name || 'Unknown';
            
            // Get subscription status
            const { data: subscription, error: subError } = await supabase
              .from('subscriptions')
              .select('status')
              .eq('organization_id', profile.organization_id)
              .single();
            
            if (!subError && subscription) {
              subStatus = subscription.status || 'Unknown';
            } else if (subError) {
              console.error('Error fetching subscription:', subError);
            }
          } else if (orgError) {
            console.error('Error fetching organization:', orgError);
          }
        } else if (profileError) {
          console.error('Error fetching user profile:', profileError);
        }
      } catch (error) {
        console.error('Error fetching org info:', error);
      }
    }

    for (const agentId of registeredAgents) {
      try {
        await axios.post(`${supportBotUrl}/sendMessage`, {
          chat_id: agentId,
          text: `🙋 <b>SUPPORT REQUESTED!</b>\n\n👤 User: ${userName}\n${sourceIcon} Source: ${chat.source}\nOrganization Name: <code>${orgName}</code>\n\nSubscription Status: <code>${subStatus}</code>\n\nUser needs help!`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📖 Open Chat', callback_data: `open_${chatId}` }],
            ],
          },
        });
      } catch (error) {
        console.error(`Failed to notify agent ${agentId}:`, error);
      }
    }

    console.log(
      `🙋 Human support requested for chat ${chatId} - notified ${registeredAgents.size} agents`
    );
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
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const telegramUserId = message.from.id;
    const text = message.text || message.caption || '';
    const firstName = message.from?.first_name || '';
    const lastName = message.from?.last_name || '';
    const from = `${firstName} ${lastName}`.trim();

    console.log(
      `📨 Telegram customer message from ${from} (${telegramUserId}): ${text}`
    );

    // Extract file data if present
    let fileUrl = '';
    let fileName = '';
    let fileType = '';

    if (message.photo && message.photo.length > 0) {
      // Get the largest photo
      const photo = message.photo[message.photo.length - 1];
      const fileId = photo.file_id;
      try {
        const fileRes = await axios.get(
          `${customerBotUrl}/getFile?file_id=${fileId}`
        );
        const filePath = fileRes.data.result.file_path;
        fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_CUSTOMER_TOKEN}/${filePath}`;
        fileName = `photo_${Date.now()}.jpg`;
        fileType = 'image/jpeg';
        console.log(`📷 Photo received: ${fileUrl}`);
      } catch (err) {
        console.error('Error getting photo file:', err);
      }
    } else if (message.document) {
      const doc = message.document;
      const fileId = doc.file_id;
      try {
        const fileRes = await axios.get(
          `${customerBotUrl}/getFile?file_id=${fileId}`
        );
        const filePath = fileRes.data.result.file_path;
        fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_CUSTOMER_TOKEN}/${filePath}`;
        fileName = doc.file_name || `document_${Date.now()}`;
        fileType = doc.mime_type || 'application/octet-stream';
        console.log(`📎 Document received: ${fileName}`);
      } catch (err) {
        console.error('Error getting document file:', err);
      }
    }

    // Generate a unique chat ID for each new user or get existing one
    let chatId = userChatMap.get(telegramUserId);

    if (!chatId || !activeChats.has(chatId)) {
      // Create new chat for this user
      chatId = `tg_${telegramUserId}_${Date.now()}`;
      userChatMap.set(telegramUserId, chatId);

      activeChats.set(chatId, {
        mode: 'bot',
        messages: [],
        source: 'telegram',
        userFirstName: firstName,
        userLastName: lastName,
        userId: String(telegramUserId),
        telegramUserId: telegramUserId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      console.log(`✨ New Telegram chat created: ${chatId} for user ${from}`);

      // Notify dashboard about new chat
      emitToDashboard('chat_mode_changed', {
        chatId,
        mode: 'bot',
        userFirstName: firstName,
        userLastName: lastName,
      });

      // Notify all agents about new Telegram chat
      await notifyAgents(chatId, text || '[Chat started]', true);
    } else {
      // Update user info if changed
      const chat = activeChats.get(chatId)!;
      chat.userFirstName = firstName;
      chat.userLastName = lastName;
    }

    const chatState = activeChats.get(chatId)!;

    // 2. Store user message with file data
    const userMessage: Message = {
      from: 'user',
      text: text || (fileUrl ? `📎 ${fileName}` : ''),
      timestamp: Date.now(),
      fileUrl,
      fileName,
      fileType,
    };
    storeMessage(chatId, userMessage, String(telegramUserId));

    // 3. Forward to dashboard
    emitToDashboard('message_from_user', {
      chatId,
      text: text || (fileUrl ? `📎 ${fileName}` : ''),
      from,
      fileUrl,
      fileName,
      fileType,
      raw: message,
    });

    // 4. If in human mode, forward to support agent via support bot
    if (chatState.mode === 'human' && chatState.agentId) {
      const agentTelegramId = parseInt(chatState.agentId);
      if (!isNaN(agentTelegramId)) {
        let messageText = `💬 Message from <b>${from}</b> (Chat: <code>${chatId}</code>):\n\n${text}`;

        if (fileUrl) {
          // Send file to agent
          if (fileType.startsWith('image/')) {
            await axios.post(`${supportBotUrl}/sendPhoto`, {
              chat_id: agentTelegramId,
              photo: fileUrl,
              caption: messageText,
              parse_mode: 'HTML',
            });
          } else {
            await axios.post(`${supportBotUrl}/sendDocument`, {
              chat_id: agentTelegramId,
              document: fileUrl,
              caption: messageText,
              parse_mode: 'HTML',
            });
          }
        } else {
          await tgSend(supportBotUrl, agentTelegramId, messageText);
        }
      }
      console.log(
        `👤 Telegram chat ${chatId} is in human mode - forwarded to agent`
      );
      return res.sendStatus(200);
    }

    // 5. Bot auto-reply
    await handleBotReply(chatId, text, 'telegram');

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Customer webhook error:', e);
    res.sendStatus(200);
  }
});

// =====================================================
// =============== SUPPORT BOT WEBHOOK =================
// =====================================================
app.post('/telegram/support/webhook', async (req, res) => {
  try {
    // Handle callback queries (button clicks)
    const callbackQuery = req.body.callback_query;
    if (callbackQuery) {
      const telegramId = callbackQuery.from.id;
      const agentName = `${callbackQuery.from.first_name ?? 'Agent'}`;
      const data = callbackQuery.data;

      // Answer callback query to remove loading state
      await axios.post(`${supportBotUrl}/answerCallbackQuery`, {
        callback_query_id: callbackQuery.id,
      });

      // Handle "open chat" button
      if (data.startsWith('open_')) {
        const chatId = data.replace('open_', '');

        // Execute the open logic
        agentChatMap.set(telegramId, chatId);
        const chat = activeChats.get(chatId);

        if (chat) {
          chat.mode = 'human';
          chat.agentId = String(telegramId);
          chat.agentName = agentName;
          chat.requestingHuman = false;
          chat.visited = true; // Mark chat as visited

          const systemMessage: Message = {
            from: 'system',
            text: `${agentName} connected`,
            timestamp: Date.now(),
          };
          storeMessage(chatId, systemMessage);
        }

        emitToDashboard('chat_mode_changed', {
          chatId,
          mode: 'human',
          agentId: String(telegramId),
          agentName,
        });

        if (chat) {
          const userName = chat.userFirstName
            ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
            : 'Anonymous';
          const sourceIcon = chat.source === 'web' ? '🌐' : '📱';

          await tgSend(
            supportBotUrl,
            telegramId,
            `✅ Chat opened: <code>${chatId}</code>\n\n👤 User: ${userName}\n${sourceIcon} Source: ${chat.source}`
          );

          if (chat.messages.length === 0) {
            await tgSend(
              supportBotUrl,
              telegramId,
              '📭 Chat is empty. No messages yet.'
            );
          } else {
            await tgSend(
              supportBotUrl,
              telegramId,
              `📜 Chat history (last 30 messages):`
            );

            for (const msg of chat.messages.slice(-30)) {
              const author =
                msg.from === 'user'
                  ? '🧑 User'
                  : msg.from === 'agent'
                    ? `👨‍💼 ${msg.agentName || 'Agent'}`
                    : msg.from === 'bot'
                      ? '🤖 Bot'
                      : '⚙️ System';

              let msgText = `${author}:\n${msg.text}`;
              if (msg.fileUrl) {
                msgText += `\n📎 File: ${msg.fileName || 'attachment'}`;
              }

              await tgSend(supportBotUrl, telegramId, msgText);
            }

            await tgSend(
              supportBotUrl,
              telegramId,
              '✏️ Type your message to reply to the user.'
            );
          }
        } else {
          await tgSend(
            supportBotUrl,
            telegramId,
            `❌ Chat <code>${chatId}</code> not found.`
          );
        }
      }

      return res.sendStatus(200);
    }

    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const telegramId = message.from.id;
    const text = message.text ?? '';
    const agentName = `${message.from.first_name ?? 'Agent'}`;

    // 1. Register agent
    if (text === '/start') {
      registeredAgents.add(telegramId);
      console.log(
        `✅ Agent ${agentName} (${telegramId}) registered. Total agents: ${registeredAgents.size}`
      );

      await tgSend(
        supportBotUrl,
        telegramId,
        '👋 Welcome, support agent!\n\n' +
          "You'll receive notifications for new chats.\n\n" +
          'Commands:\n' +
          '/list - View active chats\n' +
          '/open <chat_id> - Open a chat\n' +
          '/release - Release current chat\n' +
          'Type messages normally to reply to users.'
      );
      return res.sendStatus(200);
    }

    // 2. List active chats
    if (text === '/list') {
      const chats = Array.from(activeChats.entries());

      if (chats.length === 0) {
        await tgSend(supportBotUrl, telegramId, 'No active chats.');
        return res.sendStatus(200);
      }

      // Sort by last activity (most recent first)
      const sortedChats = chats.sort(
        (a, b) => b[1].lastActivityAt - a[1].lastActivityAt
      );

      for (const [chatId, chat] of sortedChats) {
        const requestFlag = chat.requestingHuman ? '🙋 <b>NEEDS HELP</b>' : '';
        const visitedFlag = chat.visited ? '✅' : '🆕';
        const modeIcon = chat.mode === 'human' ? '👤' : '🤖';
        const userName =
          `${chat.userFirstName || ''} ${chat.userLastName || ''}`.trim() ||
          'Anonymous';
        const sourceIcon = chat.source === 'web' ? '🌐' : '📱';

        // Format timestamps
        const createdTime = new Date(chat.createdAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        const lastActivityTime = new Date(chat.lastActivityAt).toLocaleString(
          'en-US',
          {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }
        );

        const msgCount = chat.messages.length;
        const agentInfo =
          chat.mode === 'human' && chat.agentName
            ? `\n   Agent: ${chat.agentName}`
            : '';

        let msg = `${requestFlag}\n${visitedFlag} ${modeIcon} <b>${userName}</b> ${sourceIcon}\n`;
        msg += `   Created: ${createdTime}\n`;
        msg += `   Last activity: ${lastActivityTime}\n`;
        msg += `   Messages: ${msgCount}${agentInfo}\n`;
        msg += `   ID: <code>${chatId}</code>`;

        // Send message with inline button to open chat
        try {
          await axios.post(`${supportBotUrl}/sendMessage`, {
            chat_id: telegramId,
            text: msg,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📖 Open Chat', callback_data: `open_${chatId}` }],
              ],
            },
          });
        } catch (error) {
          console.error('Failed to send chat with button:', error);
        }
      }

      return res.sendStatus(200);
    }

    // 3. Open chat (takeover)
    if (text.startsWith('/open')) {
      const parts = text.split(' ');
      const chatId = parts[1];

      if (!chatId) {
        await tgSend(supportBotUrl, telegramId, 'Usage: /open <chat_id>');
        return res.sendStatus(200);
      }

      // Save active chat for agent
      agentChatMap.set(telegramId, chatId);

      const chat = activeChats.get(chatId);

      if (chat) {
        chat.mode = 'human';
        chat.agentId = String(telegramId);
        chat.agentName = agentName;
        chat.requestingHuman = false;
        chat.visited = true; // Mark chat as visited

        // Add system message (stored but not emitted to prevent showing to web user)
        const systemMessage: Message = {
          from: 'system',
          text: `${agentName} connected`,
          timestamp: Date.now(),
        };
        storeMessage(chatId, systemMessage);
      }

      // Notify dashboard about mode change (without system message)
      emitToDashboard('chat_mode_changed', {
        chatId,
        mode: 'human',
        agentId: String(telegramId),
        agentName,
      });

      // ---------- NEW PART: SEND CHAT HISTORY ----------
      if (chat) {
        const userName = chat.userFirstName
          ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
          : 'Anonymous';
        const sourceIcon = chat.source === 'web' ? '🌐' : '📱';

        await tgSend(
          supportBotUrl,
          telegramId,
          `✅ Chat opened: <code>${chatId}</code>\n\n👤 User: ${userName}\n${sourceIcon} Source: ${chat.source}`
        );

        if (chat.messages.length === 0) {
          await tgSend(
            supportBotUrl,
            telegramId,
            '📭 Chat is empty. No messages yet.'
          );
        } else {
          await tgSend(
            supportBotUrl,
            telegramId,
            `📜 Chat history (last 30 messages):`
          );

          for (const msg of chat.messages.slice(-30)) {
            // last 30 messages
            const author =
              msg.from === 'user'
                ? '🧑 User'
                : msg.from === 'agent'
                  ? `👨‍💼 ${msg.agentName || 'Agent'}`
                  : msg.from === 'bot'
                    ? '🤖 Bot'
                    : '⚙️ System';

            await tgSend(supportBotUrl, telegramId, `${author}:\n${msg.text}`);
          }

          await tgSend(
            supportBotUrl,
            telegramId,
            '✏️ Type your message to reply to the user.'
          );
        }
      } else {
        await tgSend(
          supportBotUrl,
          telegramId,
          `❌ Chat <code>${chatId}</code> not found.`
        );
      }
      // --------------------------------------------------

      return res.sendStatus(200);
    }
    // 4. Release chat
    if (text === '/release') {
      const currentChat = agentChatMap.get(telegramId);
      if (!currentChat) {
        await tgSend(supportBotUrl, telegramId, 'No chat is currently opened.');
        return res.sendStatus(200);
      }

      agentChatMap.delete(telegramId);

      const chat = activeChats.get(currentChat);
      if (chat) {
        // Store system message about agent leaving
        const systemMessage: Message = {
          from: 'system',
          text: `${agentName} disconnected`,
          timestamp: Date.now(),
        };
        storeMessage(currentChat, systemMessage);

        chat.mode = 'bot';
        delete chat.agentId;
        delete chat.agentName;
        chat.requestingHuman = false;
      }

      emitToDashboard('chat_mode_changed', {
        chatId: currentChat,
        mode: 'bot',
      });

      await tgSend(
        supportBotUrl,
        telegramId,
        `🔓 Released chat <code>${currentChat}</code>`
      );
      console.log(`🔓 Chat ${currentChat} released by agent ${agentName}`);
      return res.sendStatus(200);
    }

    // 5. Send message from agent to user
    const currentChat = agentChatMap.get(telegramId);
    if (currentChat) {
      const chat = activeChats.get(currentChat);

      if (!chat) {
        await tgSend(
          supportBotUrl,
          telegramId,
          `❌ Chat <code>${currentChat}</code> not found. Use /list to see active chats.`
        );
        return res.sendStatus(200);
      }

      // Extract file data if agent sent a file
      let fileUrl = '';
      let fileName = '';
      let fileType = '';

      if (message.photo && message.photo.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        const fileId = photo.file_id;
        try {
          const fileRes = await axios.get(
            `${supportBotUrl}/getFile?file_id=${fileId}`
          );
          const filePath = fileRes.data.result.file_path;
          fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_SUPPORT_TOKEN}/${filePath}`;
          fileName = `photo_${Date.now()}.jpg`;
          fileType = 'image/jpeg';
          console.log(`📷 Agent sent photo: ${fileUrl}`);
        } catch (err) {
          console.error('Error getting agent photo:', err);
        }
      } else if (message.document) {
        const doc = message.document;
        const fileId = doc.file_id;
        try {
          const fileRes = await axios.get(
            `${supportBotUrl}/getFile?file_id=${fileId}`
          );
          const filePath = fileRes.data.result.file_path;
          fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_SUPPORT_TOKEN}/${filePath}`;
          fileName = doc.file_name || `document_${Date.now()}`;
          fileType = doc.mime_type || 'application/octet-stream';
          console.log(`📎 Agent sent document: ${fileName}`);
        } catch (err) {
          console.error('Error getting agent document:', err);
        }
      }

      const messageText = message.text || message.caption || '';

      // Save agent message with file data
      const agentMessage: Message = {
        from: 'agent',
        text: messageText || (fileUrl ? `📎 ${fileName}` : ''),
        timestamp: Date.now(),
        agentId: String(telegramId),
        agentName,
        fileUrl,
        fileName,
        fileType,
      };
      storeMessage(currentChat, agentMessage);

      // Send to customer based on source
      if (chat.source === 'telegram' && chat.telegramUserId) {
        // Telegram user - forward file or text
        if (fileUrl) {
          if (fileType.startsWith('image/')) {
            await axios.post(`${customerBotUrl}/sendPhoto`, {
              chat_id: chat.telegramUserId,
              photo: fileUrl,
              caption: messageText,
              parse_mode: 'HTML',
            });
          } else {
            await axios.post(`${customerBotUrl}/sendDocument`, {
              chat_id: chat.telegramUserId,
              document: fileUrl,
              caption: messageText,
              parse_mode: 'HTML',
            });
          }
        } else {
          await tgSend(customerBotUrl, chat.telegramUserId, messageText);
        }
      } else if (chat.source === 'web') {
        // Web user - send via Socket.IO (handled by emitToDashboard below)
        console.log(
          `📤 Sending agent message to web user via Socket.IO: ${currentChat}`
        );
      }

      // Notify dashboard (this sends to web users via Socket.IO)
      emitToDashboard('message_from_agent', {
        chatId: currentChat,
        message: messageText || (fileUrl ? `📎 ${fileName}` : ''),
        agentId: String(telegramId),
        agentName,
        fileUrl,
        fileName,
        fileType,
      });

      console.log(
        `👨‍💼 Agent ${agentName} sent ${fileUrl ? 'file' : 'text'} to ${currentChat} (${chat.source})`
      );
      return res.sendStatus(200);
    }

    // No chat opened
    await tgSend(
      supportBotUrl,
      telegramId,
      'Use /list to view chats or /open <id> to start chatting.'
    );
    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Support webhook error:', e);
    res.sendStatus(200);
  }
});

// =====================================================
// HTTP ENDPOINTS FOR DASHBOARD
// =====================================================

// Simple health route
app.get('/health', (req, res) => res.json({ ok: true }));

// Send message to user (agent message)
app.post('/send', async (req, res) => {
  const { chatId, message, agentId, agentName } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'Missing chatId or message' });
  }

  const chat = activeChats.get(chatId);

  try {
    // Send via customer Telegram bot if it's a Telegram chat
    if (chat?.source === 'telegram' && chat.telegramUserId) {
      await tgSend(customerBotUrl, chat.telegramUserId, message);
    }

    // Store and emit agent message
    const agentMessage: Message = {
      from: 'agent',
      text: message,
      timestamp: Date.now(),
      agentId,
      agentName,
    };
    storeMessage(chatId, agentMessage);

    emitToDashboard('message_from_agent', {
      chatId,
      message,
      agentId,
      agentName,
    });
    console.log(`👨‍💼 Agent ${agentName || agentId} sent message to ${chatId}`);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send message:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// Takeover chat: switch chat to human mode
app.post('/takeover', async (req, res) => {
  const { chatId, agentId, agentName } = req.body;
  if (!chatId || !agentId) {
    return res.status(400).json({ error: 'Missing chatId or agentId' });
  }

  const chat = activeChats.get(String(chatId));

  if (chat) {
    const previousMode = chat.mode;
    chat.mode = 'human';
    chat.agentId = agentId;
    chat.agentName = agentName;
    chat.requestingHuman = false;

    if (previousMode === 'bot' && agentName) {
      const systemMessage: Message = {
        from: 'system',
        text: `${agentName} connected`,
        timestamp: Date.now(),
      };
      storeMessage(String(chatId), systemMessage, chat.userId);
    }
  }

  emitToDashboard('chat_mode_changed', {
    chatId: String(chatId),
    mode: 'human',
    agentId,
    agentName,
  });

  console.log(`🔧 Agent ${agentName || agentId} took over chat ${chatId}`);
  return res.json({ ok: true });
});

// Release chat: return to bot mode
app.post('/release', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) {
    return res.status(400).json({ error: 'Missing chatId' });
  }

  const chat = activeChats.get(String(chatId));
  if (chat) {
    chat.mode = 'bot';
    delete chat.agentId;
    delete chat.agentName;
    chat.requestingHuman = false;
  }

  emitToDashboard('chat_mode_changed', {
    chatId: String(chatId),
    mode: 'bot',
  });

  console.log(`🔓 Chat ${chatId} released back to bot`);
  return res.json({ ok: true });
});

// Get or create chat session (in-memory only)
app.post('/api/chat/session', async (req, res) => {
  const { chatId, userId } = req.body;

  if (!chatId || !userId) {
    return res.status(400).json({ error: 'Missing chatId or userId' });
  }

  try {
    let chat = activeChats.get(chatId);
    let created = false;

    if (!chat) {
      // Create new chat session in memory
      activeChats.set(chatId, {
        mode: 'bot',
        messages: [],
        source: 'web',
        userId: userId,
        requestingHuman: false,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
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
        source: chat.source,
      },
      created,
    });
  } catch (error: any) {
    console.error('Failed to create/get chat session:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Load chat history (from memory)
app.get('/api/chat/history/:chatId', async (req, res) => {
  const { chatId } = req.params;

  try {
    const chat = activeChats.get(chatId);
    const messages = chat?.messages || [];
    return res.json({ messages });
  } catch (error: any) {
    console.error('Failed to load chat history:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get user's chat sessions (from memory)
app.get('/api/chat/sessions/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const sessions: any[] = [];

    for (const [chatId, chat] of activeChats.entries()) {
      if (chat.userId === userId) {
        const lastMessage =
          chat.messages.length > 0
            ? chat.messages[chat.messages.length - 1]
            : null;

        sessions.push({
          id: chatId,
          mode: chat.mode,
          source: chat.source,
          lastMessage: lastMessage?.text || 'No messages yet',
          messageCount: chat.messages.length,
        });
      }
    }

    return res.json({ sessions });
  } catch (error: any) {
    console.error('Failed to load chat sessions:', error);
    return res.status(500).json({ error: error.message });
  }
});

// =====================================================
// SOCKET.IO CONNECTIONS
// =====================================================
io.on('connection', (socket) => {
  console.log('✅ Client connected', socket.id);

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
    userLastName: state.userLastName,
  }));

  socket.emit('active_chats_snapshot', snapshot);
  console.log(`📸 Sent snapshot of ${snapshot.length} chats`);

  // Handle WEB USER MESSAGES
  socket.on(
    'user_message',
    async ({
      chatId,
      message,
      text,
      firstName,
      userFirstName,
      lastName,
      userLastName,
      userId,
      fileUrl,
      fileName,
      fileType,
    }: {
      chatId: string;
      message?: string;
      text?: string;
      firstName?: string;
      userFirstName?: string;
      lastName?: string;
      userLastName?: string;
      userId?: string;
      fileUrl?: string;
      fileName?: string;
      fileType?: string;
    }) => {
      const messageText = message || text || '';
      const fName = firstName || userFirstName;
      const lName = lastName || userLastName;

      console.log(
        `📨 Web user message from ${chatId}: ${messageText}${fileUrl ? ` [+ file: ${fileName}]` : ''}`
      );

      const isNewChat = !activeChats.has(chatId);

      if (isNewChat) {
        // Create new chat for web user
        activeChats.set(chatId, {
          mode: 'bot',
          messages: [],
          source: 'web',
          userFirstName: fName,
          userLastName: lName,
          userId,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        });

        console.log(
          `✨ New web chat created: ${chatId} for user ${fName} ${lName}`
        );

        emitToDashboard('chat_mode_changed', {
          chatId,
          mode: 'bot',
          userFirstName: fName,
          userLastName: lName,
        });

        // Notify all agents about new web chat
        await notifyAgents(chatId, messageText, true);
      } else {
        const chat = activeChats.get(chatId)!;
        if (fName) chat.userFirstName = fName;
        if (lName) chat.userLastName = lName;
        if (userId) chat.userId = userId;
      }

      const chat = activeChats.get(chatId)!;

      const userMessage: Message = {
        from: 'user',
        text: messageText || (fileUrl ? `📎 ${fileName}` : ''),
        timestamp: Date.now(),
        fileUrl,
        fileName,
        fileType,
      };
      storeMessage(chatId, userMessage, userId);

      emitToDashboard('message_from_user', {
        chatId,
        text: messageText,
        from: chat.userFirstName
          ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
          : undefined,
        fileUrl,
        fileName,
        fileType,
      });

      // If in human mode, send message directly to the agent handling this chat
      if (chat.mode === 'human' && chat.agentId) {
        const agentTelegramId = parseInt(chat.agentId);
        if (!isNaN(agentTelegramId)) {
          const senderName = chat.userFirstName
            ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
            : 'User';

          if (fileUrl) {
            let finalFileUrl = fileUrl;

            // Check if it's a base64 file - upload to Supabase first
            if (fileUrl.startsWith('data:')) {
              console.log(`📤 Uploading base64 file to Supabase: ${fileName}`);
              const uploadedUrl = await uploadFileToSupabase(
                fileUrl,
                fileName || 'file',
                fileType || 'application/octet-stream',
                chatId
              );

              if (uploadedUrl) {
                finalFileUrl = uploadedUrl;
                console.log(
                  `✅ File uploaded successfully, public URL: ${uploadedUrl}`
                );
              } else {
                // Upload failed - notify both agent and user
                await tgSend(
                  supportBotUrl,
                  agentTelegramId,
                  `💬 From <b>${senderName}</b> (Chat: <code>${chatId}</code>):\n\n${messageText}\n\n📎 User attempted to send file: <code>${fileName}</code>\n❌ File upload failed`
                );

                // Send error message to web user
                const errorMessage: Message = {
                  from: 'system',
                  text: `❌ Sorry, your file "${fileName}" failed to upload. Please try again or contact support if the problem persists.`,
                  timestamp: Date.now(),
                };
                storeMessage(chatId, errorMessage, userId);
                emitToDashboard('message_from_bot', {
                  chatId,
                  text: errorMessage.text,
                });

                console.error(
                  `❌ Failed to upload file to Supabase for chat ${chatId}`
                );
                return;
              }
            }

            // Send file to agent via Telegram (now with public URL)
            if (fileType?.startsWith('image/')) {
              await axios.post(`${supportBotUrl}/sendPhoto`, {
                chat_id: agentTelegramId,
                photo: finalFileUrl,
                caption: `💬 From <b>${senderName}</b> (Chat: <code>${chatId}</code>):\n\n${messageText}`,
                parse_mode: 'HTML',
              });
            } else {
              await axios.post(`${supportBotUrl}/sendDocument`, {
                chat_id: agentTelegramId,
                document: finalFileUrl,
                caption: `💬 From <b>${senderName}</b> (Chat: <code>${chatId}</code>):\n\n${messageText}`,
                parse_mode: 'HTML',
              });
            }

            console.log(`✅ Sent file to agent: ${finalFileUrl}`);
          } else {
            await tgSend(
              supportBotUrl,
              agentTelegramId,
              `💬 From <b>${senderName}</b> (Chat: <code>${chatId}</code>):\n\n${messageText}`
            );
          }
          console.log(
            `🔀 Forwarded web message with ${fileUrl ? 'file' : 'text'} to agent ${chat.agentName}`
          );
        }
        return;
      }

      // 5. Bot auto-reply (only if not in human mode)
      if (messageText || !fileUrl) {
        await handleBotReply(chatId, messageText, 'web');
      } else {
        // If only file, send acknowledgment
        const botResponse =
          'Thank you for sending that file! How can I help you today?';
        const botMessage: Message = {
          from: 'bot',
          text: botResponse,
          timestamp: Date.now(),
        };
        storeMessage(chatId, botMessage, userId);
        emitToDashboard('message_from_bot', { chatId, text: botResponse });
      }
    }
  );

  // Handle new chat creation
  socket.on(
    'create_new_chat',
    ({
      chatId,
      firstName,
      lastName,
      userId,
    }: {
      chatId: string;
      firstName?: string;
      lastName?: string;
      userId?: string;
    }) => {
      console.log(
        `✨ Creating new web chat: ${chatId} for user ${firstName} ${lastName}`
      );

      // Create new chat session
      activeChats.set(chatId, {
        mode: 'bot',
        messages: [],
        source: 'web',
        userFirstName: firstName,
        userLastName: lastName,
        userId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      // Notify dashboard about new chat
      emitToDashboard('chat_mode_changed', {
        chatId,
        mode: 'bot',
        userFirstName: firstName,
        userLastName: lastName,
      });

      // Send welcome message
      const welcomeMessage: Message = {
        from: 'bot',
        text: '👋 Hello! How can I help you today?',
        timestamp: Date.now(),
      };
      storeMessage(chatId, welcomeMessage, userId);
      emitToDashboard('bot_message', { chatId, text: welcomeMessage.text });

      console.log(`✅ New chat ${chatId} created successfully`);
    }
  );

  // Handle user info updates
  socket.on(
    'user_info',
    ({
      chatId,
      firstName,
      lastName,
      userId,
    }: {
      chatId: string;
      firstName?: string;
      lastName?: string;
      userId?: string;
    }) => {
      let chat = activeChats.get(chatId);

      // If chat doesn't exist, create it
      if (!chat) {
        console.log(
          `✨ Creating chat ${chatId} via user_info for user ${firstName} ${lastName}`
        );
        activeChats.set(chatId, {
          mode: 'bot',
          messages: [],
          source: 'web',
          userFirstName: firstName,
          userLastName: lastName,
          userId,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        });
        chat = activeChats.get(chatId)!;

        // Send welcome message for new chat
        const welcomeMessage: Message = {
          from: 'bot',
          text: '👋 Hello! How can I help you today?',
          timestamp: Date.now(),
        };
        storeMessage(chatId, welcomeMessage, userId);
        emitToDashboard('bot_message', { chatId, text: welcomeMessage.text });
      } else {
        // Update existing chat info
        if (firstName) chat.userFirstName = firstName;
        if (lastName) chat.userLastName = lastName;
        if (userId) chat.userId = userId;
      }

      emitToDashboard('chat_mode_changed', {
        chatId,
        mode: chat.mode,
        agentId: chat.agentId,
        agentName: chat.agentName,
        userFirstName: chat.userFirstName,
        userLastName: chat.userLastName,
        requestingHuman: chat.requestingHuman,
      });
    }
  );

  // Handle human support request
  socket.on('request_human_support', async ({ chatId }: { chatId: string }) => {
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard('human_support_requested', { chatId });
      sendBotMessage(
        chatId,
        "🙋 I've notified our support team. An agent will join you shortly.",
        chat.source
      );

      // Send immediate notification to all agents with inline button
      const userName = chat.userFirstName
        ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
        : 'Anonymous';
      const sourceIcon = chat.source === 'web' ? '🌐' : '📱';

      for (const agentId of registeredAgents) {
        try {
          await axios.post(`${supportBotUrl}/sendMessage`, {
            chat_id: agentId,
            text: `🙋 <b>SUPPORT REQUESTED!</b>\n\n👤 User: ${userName}\n${sourceIcon} Source: ${chat.source}\nID: <code>${chatId}</code>\n\nUser needs help!`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📖 Open Chat', callback_data: `open_${chatId}` }],
              ],
            },
          });
        } catch (error) {
          console.error(`Failed to notify agent ${agentId}:`, error);
        }
      }

      console.log(
        `🙋 Human support requested via button for chat ${chatId} - notified ${registeredAgents.size} agents`
      );
    }
  });

  socket.on('request_human', async ({ chatId }: { chatId: string }) => {
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard('human_support_requested', { chatId });
      sendBotMessage(
        chatId,
        "🙋 I've notified our support team. An agent will join you shortly.",
        chat.source
      );

      // Send immediate notification to all agents with inline button
      const userName = chat.userFirstName
        ? `${chat.userFirstName} ${chat.userLastName || ''}`.trim()
        : 'Anonymous';
      const sourceIcon = chat.source === 'web' ? '🌐' : '📱';

      for (const agentId of registeredAgents) {
        try {
          await axios.post(`${supportBotUrl}/sendMessage`, {
            chat_id: agentId,
            text: `🙋 <b>SUPPORT REQUESTED!</b>\n\n👤 User: ${userName}\n${sourceIcon} Source: ${chat.source}\nID: <code>${chatId}</code>\n\nUser needs help!`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📖 Open Chat', callback_data: `open_${chatId}` }],
              ],
            },
          });
        } catch (error) {
          console.error(`Failed to notify agent ${agentId}:`, error);
        }
      }

      console.log(
        `🙋 Human support requested for chat ${chatId} - notified ${registeredAgents.size} agents`
      );
    }
  });

  // Dashboard sends message
  socket.on('send_message', async ({ chatId, message, agentId, agentName }) => {
    const chat = activeChats.get(String(chatId));

    try {
      if (chat?.source === 'telegram' && chat.telegramUserId) {
        await tgSend(customerBotUrl, chat.telegramUserId, message);
      }

      const agentMessage: Message = {
        from: 'agent',
        text: message,
        timestamp: Date.now(),
        agentId,
        agentName,
      };
      storeMessage(String(chatId), agentMessage, chat?.userId);

      emitToDashboard('message_from_agent', {
        chatId,
        message,
        agentId,
        agentName,
      });
    } catch (err) {
      console.error('Failed to send via socket', err);
      socket.emit('error', { message: 'send_failed' });
    }
  });

  // Takeover via socket
  socket.on('takeover', async ({ chatId, agentId, agentName }) => {
    const chat = activeChats.get(String(chatId));

    if (chat) {
      const previousMode = chat.mode;
      chat.mode = 'human';
      chat.agentId = agentId;
      chat.agentName = agentName;
      chat.requestingHuman = false;

      // Store system message but don't emit to prevent showing to web user
      if (previousMode === 'bot' && agentName) {
        const systemMessage: Message = {
          from: 'system',
          text: `${agentName} connected`,
          timestamp: Date.now(),
        };
        storeMessage(String(chatId), systemMessage, chat.userId);
      }
    }

    // Only emit mode change, not the system message
    emitToDashboard('chat_mode_changed', {
      chatId: String(chatId),
      mode: 'human',
      agentId,
      agentName,
    });
  });

  // Release via socket
  socket.on('release', async ({ chatId }) => {
    const chat = activeChats.get(String(chatId));
    if (chat) {
      const agentName = chat.agentName;

      // Store system message about agent leaving
      if (agentName) {
        const systemMessage: Message = {
          from: 'system',
          text: `${agentName} disconnected`,
          timestamp: Date.now(),
        };
        storeMessage(String(chatId), systemMessage, chat.userId);
      }

      chat.mode = 'bot';
      delete chat.agentId;
      delete chat.agentName;
      chat.requestingHuman = false;
    }

    emitToDashboard('chat_mode_changed', {
      chatId: String(chatId),
      mode: 'bot',
    });
  });

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected', socket.id);
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
  console.log(`👥 Registered agents: ${registeredAgents.size}`);
  console.log(`\n📋 Customer Bot Webhook: ${WEBHOOK_URL}/webhook`);
  console.log(
    `📋 Support Bot Webhook: ${WEBHOOK_URL}/telegram/support/webhook`
  );
  console.log(
    `\n⚠️  IMPORTANT: Agents must use /start in support bot to receive notifications!`
  );
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
