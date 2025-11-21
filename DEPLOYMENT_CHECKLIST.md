# Deployment Checklist for GerkoBot

## Pre-Deployment

- [ ] Review all code changes in `server/server.ts`
- [ ] Verify `package.json` has all dependencies (axios, socket.io, etc.)
- [ ] Create `.env` file from `.env.example`
- [ ] Fill in all environment variables

## Environment Variables

- [ ] `PORT` - Server port (default: 3001)
- [ ] `FRONTEND_ORIGIN` - Your frontend URL
- [ ] `BACKEND_URL` - Your server URL (https://gerkobot.onrender.com)
- [ ] `TELEGRAM_BOT_TOKEN` - Customer bot token from @BotFather
- [ ] `TELEGRAM_BOT_SUPPORT_TOKEN` - Support bot token from @BotFather
- [ ] `VITE_SUPABASE_URL` - Supabase project URL
- [ ] `VITE_SUPABASE_PUBLISHABLE_KEY` - Supabase anon key

## Supabase Setup

- [ ] Create `chat_sessions` table (see UPDATE_SUMMARY.md for schema)
- [ ] Create `chat_messages` table with JSONB chat_history column
- [ ] Create `support_agents` table
- [ ] Enable Row Level Security (RLS) policies if needed
- [ ] Test database connection

## Local Testing

- [ ] Install dependencies: `cd server && npm install`
- [ ] Start server: `npm run dev:ts`
- [ ] Test health endpoint: `curl http://localhost:3001/health`
- [ ] Verify no TypeScript errors
- [ ] Check console logs for startup messages

## Telegram Bot Configuration

### Customer Bot
- [ ] Created bot via @BotFather
- [ ] Saved bot token
- [ ] Set bot name and description
- [ ] Configure bot commands (optional)

### Support Bot
- [ ] Created bot via @BotFather
- [ ] Saved bot token
- [ ] Set bot name and description
- [ ] Configure bot commands: /start, /list, /open, /release

## Render.com Deployment

- [ ] Push code to GitHub repository
- [ ] Create new Web Service on Render.com
- [ ] Connect GitHub repository
- [ ] Set Build Command: `cd server && npm install`
- [ ] Set Start Command: `cd server && npm start`
- [ ] Add all environment variables in Render dashboard
- [ ] Deploy service
- [ ] Wait for deployment to complete
- [ ] Check deployment logs for errors

## Webhook Configuration

After successful deployment:

### Customer Bot Webhook
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_CUSTOMER_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://gerkobot.onrender.com/telegram/customer/webhook"}'
```

Expected response:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### Support Bot Webhook
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_SUPPORT_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://gerkobot.onrender.com/telegram/support/webhook"}'
```

Expected response:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### Verify Webhooks
```bash
# Check customer bot
curl "https://api.telegram.org/bot<YOUR_CUSTOMER_BOT_TOKEN>/getWebhookInfo"

# Check support bot
curl "https://api.telegram.org/bot<YOUR_SUPPORT_BOT_TOKEN>/getWebhookInfo"
```

## Post-Deployment Testing

### Test Customer Bot
- [ ] Send message to customer bot on Telegram
- [ ] Verify bot responds with auto-reply
- [ ] Type "agent" and verify human support request works
- [ ] Check Render logs for incoming webhook requests
- [ ] Verify message saved to Supabase

### Test Support Bot
- [ ] Send `/start` to support bot
- [ ] Verify agent registration message
- [ ] Send `/list` and verify active chats displayed
- [ ] Find a chat ID and send `/open <chat_id>`
- [ ] Send a message to verify it forwards to customer
- [ ] Check customer bot receives the message
- [ ] Send `/release` to return chat to bot mode

### Test Dashboard (if applicable)
- [ ] Connect dashboard via Socket.IO to server
- [ ] Verify active chats snapshot received
- [ ] Send message from dashboard to customer
- [ ] Verify real-time updates work
- [ ] Test takeover and release from dashboard
- [ ] Check human support request notifications

## Monitoring

- [ ] Set up Render.com monitoring/alerts
- [ ] Check Render logs regularly: `https://dashboard.render.com`
- [ ] Monitor Supabase database usage
- [ ] Monitor Telegram bot webhook status
- [ ] Set up error tracking (optional: Sentry, Bugsnag)

## Troubleshooting

If something doesn't work:

1. **Check Render Logs**
   - Go to Render dashboard → Your service → Logs
   - Look for startup errors or webhook errors

2. **Verify Environment Variables**
   - Render dashboard → Your service → Environment
   - Ensure all variables are set correctly

3. **Test Webhooks**
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```
   Look for errors in the response

4. **Check Database**
   - Verify tables exist in Supabase
   - Check for any database connection errors in logs

5. **Test Endpoints**
   ```bash
   curl https://gerkobot.onrender.com/health
   ```

## Rollback Plan

If deployment fails:

- [ ] Revert to previous git commit
- [ ] Redeploy on Render.com
- [ ] Update webhooks if URLs changed
- [ ] Notify users of downtime

## Documentation

- [ ] `README.md` - Updated architecture docs
- [ ] `TELEGRAM_SETUP.md` - Complete setup guide
- [ ] `UPDATE_SUMMARY.md` - Change summary
- [ ] `.env.example` - Environment template
- [ ] This checklist completed ✓

## Success Criteria

✅ Server starts without errors  
✅ Health endpoint returns 200 OK  
✅ Customer bot receives and responds to messages  
✅ Support bot commands work (/start, /list, /open, /release)  
✅ Messages forward between customer and agent  
✅ Chat history persists to Supabase  
✅ Socket.IO dashboard connects (if applicable)  
✅ No errors in Render logs  
✅ Webhooks return healthy status  

## Next Steps

After successful deployment:

1. Share customer bot link with end-users
2. Invite support agents to use support bot
3. Connect dashboard for web-based chat management
4. Monitor usage and performance
5. Iterate based on user feedback

## Support & Resources

- Render.com Docs: https://render.com/docs
- Telegram Bot API: https://core.telegram.org/bots/api
- Supabase Docs: https://supabase.com/docs
- Socket.IO Docs: https://socket.io/docs/

---

**Status**: ⬜ Not Started | 🔄 In Progress | ✅ Complete | ❌ Failed

Last Updated: $(date)
