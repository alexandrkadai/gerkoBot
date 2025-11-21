# GerkoBot - Telegram Support Bot

A TypeScript-based Telegram bot with dashboard support for human agent handoff.

## Features

- 🤖 Automated bot responses
- 👤 Human agent takeover capability
- 📊 Real-time dashboard with Socket.io
- 💬 Message history tracking
- 🔄 Seamless bot-to-human handoff

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env` file:**
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   PORT=3001
   FRONTEND_ORIGIN=http://localhost:3000
   ```

3. **Get your Telegram Bot Token:**
   - Message @BotFather on Telegram
   - Create a new bot with `/newbot`
   - Copy the token to your `.env` file

## Development

### Run TypeScript directly (recommended for development):
```bash
npm run dev:ts
```

### Run with hot reload:
```bash
npm run dev:ts
```

### Build and run production:
```bash
npm run build
npm start
```

## API Endpoints

- `POST /send` - Send message as agent
- `POST /takeover` - Switch chat to human mode  
- `POST /release` - Return chat to bot mode
- `GET /health` - Health check

## Socket.io Events

- `message_from_user` - User sent message
- `message_from_agent` - Agent sent message
- `chat_mode_changed` - Chat mode switched
- `active_chats_snapshot` - Current chat states

## Project Structure

- `server.ts` - Main TypeScript server file
- `server.js` - Compiled JavaScript (legacy)
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration
- `.env` - Environment variables (not in git)

## Scripts

- `npm run dev:ts` - Run TypeScript with hot reload
- `npm run start:ts` - Run TypeScript once
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run compiled JavaScript
- `npm run dev` - Run JavaScript with nodemon