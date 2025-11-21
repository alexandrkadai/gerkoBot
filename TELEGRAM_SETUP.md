# Telegram Bot Setup Guide

## Overview
The updated `server.ts` now supports **two Telegram bots** with Socket.IO integration for real-time dashboard communication:
- **Customer Bot**: For end-users to chat with your support system
- **Support Bot**: For support agents to manage and reply to customer chats

## Environment Variables Required

Add these to your `.env` file in the `server/` directory:

```env
PORT=3001
FRONTEND_ORIGIN=http://localhost:8080
BACKEND_URL=https://gerkobot.onrender.com

# Telegram Bot Tokens
TELEGRAM_BOT_TOKEN=your_customer_bot_token_here
TELEGRAM_BOT_SUPPORT_TOKEN=your_support_bot_token_here

# Supabase (for chat persistence)
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_key
```

## Setting Up Telegram Webhooks

Once your server is deployed to https://gerkobot.onrender.com, configure the webhooks:

### Customer Bot Webhook
```bash
curl -X POST "https://api.telegram.org/bot<CUSTOMER_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://gerkobot.onrender.com/telegram/customer/webhook"}'
```

### Support Bot Webhook
```bash
curl -X POST "https://api.telegram.org/bot<SUPPORT_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://gerkobot.onrender.com/telegram/support/webhook"}'
```

## Support Agent Commands

Support agents interact with the **Support Bot** using these commands:

- `/start` - Register as a support agent
- `/list` - View all active chat sessions  
- `/open <chat_id>` - Take over a chat (switch to human mode)
- `/release` - Release the current chat back to bot mode
- After opening a chat, just type messages normally to reply to customers

## Customer Bot Behavior

Customers interact with the **Customer Bot**:
- Messages are automatically handled by the bot (auto-replies)
- Users can type "agent" or "human support" to request a human agent
- When in human mode, messages are forwarded to the support agent

## Features

✅ **Two-Bot Architecture**: Separate bots for customers and agents  
✅ **Socket.IO Integration**: Real-time dashboard updates  
✅ **Chat Persistence**: Messages stored in Supabase  
✅ **Agent Takeover**: Support agents can take over chats via Telegram  
✅ **Auto-Replies**: Keyword-based automatic responses  
✅ **Human Support Requests**: Users can request human agents  
✅ **Multi-Source**: Supports both web and Telegram users  

## API Endpoints

### HTTP Endpoints (for Dashboard)
- `GET /health` - Health check
- `POST /send` - Send message to user
- `POST /takeover` - Agent takes over chat
- `POST /release` - Release chat back to bot
- `POST /api/chat/session` - Create/get chat session
- `GET /api/chat/history/:chatId` - Load chat history
- `GET /api/chat/sessions/:userId` - Get user's chat sessions

### Webhooks
- `POST /telegram/customer/webhook` - Customer bot webhook
- `POST /telegram/support/webhook` - Support bot webhook

### Socket.IO Events

**Client → Server:**
- `user_message` - User sends message
- `user_info` - Update user information
- `request_human_support` - Request human agent
- `send_message` - Agent sends message
- `takeover` - Agent takes over chat
- `release` - Release chat

**Server → Client:**
- `active_chats_snapshot` - Initial chat state
- `message_from_user` - User sent message
- `message_from_agent` - Agent sent message
- `bot_message` - Bot sent message
- `chat_mode_changed` - Chat mode changed (bot/human)
- `human_support_requested` - User requested human support

## Testing

1. **Start the server:**
   ```bash
   cd server
   npm install
   npm run dev
   ```

2. **Test Customer Bot:**
   - Send a message to your customer bot on Telegram
   - It should auto-reply or respond based on keywords

3. **Test Support Bot:**
   - Send `/start` to your support bot
   - Use `/list` to see active chats
   - Use `/open <chat_id>` to take over a chat
   - Send messages to reply to customers

4. **Test Dashboard:**
   - Connect your dashboard via Socket.IO
   - You should see real-time updates of all chats

## Deployment on Render.com

1. Push your code to GitHub
2. Create a new Web Service on Render.com
3. Set the build command: `cd server && npm install`
4. Set the start command: `cd server && npm start`
5. Add all environment variables
6. Deploy and configure webhooks with the deployed URL

## Troubleshooting

- **Webhook not working**: Check that BACKEND_URL matches your deployed URL
- **Messages not saving**: Verify Supabase credentials
- **Bot not responding**: Check bot tokens and webhook configuration
- **Socket.IO not connecting**: Verify FRONTEND_ORIGIN matches your frontend URL

## Database Schema

Ensure these tables exist in Supabase:

### `chat_sessions`
```sql
- id (uuid, primary key)
- user_id (text)
- mode (text) -- 'bot' or 'human'
- agent_id (text, nullable)
- requesting_human (boolean)
- source (text) -- 'web' or 'telegram'
- created_at (timestamp)
- updated_at (timestamp)
```

### `chat_messages`
```sql
- id (uuid, primary key)
- chat_id (uuid, foreign key to chat_sessions)
- chat_history (jsonb) -- array of message objects
- archived (boolean)
- created_at (timestamp)
- updated_at (timestamp)
```

### `support_agents`
```sql
- id (uuid, primary key)
- telegram_id (bigint, unique)
- name (text)
- is_active (boolean)
- created_at (timestamp)
- updated_at (timestamp)
```
