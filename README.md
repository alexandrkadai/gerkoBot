# GerkoBot - Telegram Support Bot

## Overview

A dual-bot Telegram support system with Socket.IO integration for real-time dashboard communication.

- **Customer Bot**: End-users chat with automated responses and can request human support
- **Support Bot**: Agents manage chats, take over conversations, and provide human support
- **Socket.IO**: Real-time bidirectional communication with web dashboard
- **Supabase**: Persistent chat history and session management

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file (see `.env.example` or TELEGRAM_SETUP.md)

3. **Run in development:**
   ```bash
   npm run dev:ts
   ```

4. **Build for production:**
   ```bash
   npm run build
   npm start
   ```

## Documentation

- **[TELEGRAM_SETUP.md](./TELEGRAM_SETUP.md)** - Complete setup guide with:
  - Environment configuration
  - Webhook setup
  - Agent commands
  - API endpoints
  - Database schema
  - Troubleshooting

## Key Features

✅ Two-bot architecture (customer + support)  
✅ Real-time Socket.IO communication  
✅ Chat persistence with Supabase  
✅ Agent takeover via Telegram  
✅ Keyword-based auto-replies  
✅ Human support requests  
✅ Multi-source support (web + Telegram)  

## Deployment

Deployed on Render.com at: https://gerkobot.onrender.com

See TELEGRAM_SETUP.md for detailed deployment instructions.

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│  Customer   │◄────────┤ Customer Bot │◄────────┤  Telegram   │
│  (Telegram) │         └──────────────┘         │   API       │
└─────────────┘                │                 └─────────────┘
                               │
                               ▼
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Web User  │◄────────┤   Socket.IO  │◄────────┤  Supabase   │
│ (Dashboard) │         │    Server    │         │  Database   │
└─────────────┘         └──────────────┘         └─────────────┘
                               ▲
                               │
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Support   │◄────────┤  Support Bot │◄────────┤  Telegram   │
│   Agent     │         └──────────────┘         │   API       │
│ (Telegram)  │                                  └─────────────┘
└─────────────┘
```

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