// Socket.IO event handlers - to be appended to server.ts

// =====================================================
// SOCKET.IO CONNECTIONS
// =====================================================
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
      
      // Create session in database if userId provided
      if (userId && supabase) {
        try {
          const { data: existing } = await supabase
            .from('chat_sessions')
            .select('id')
            .eq('id', chatId)
            .maybeSingle();

          if (!existing) {
            await (supabase.from('chat_sessions') as any).insert({
              id: chatId,
              user_id: userId,
              mode: 'bot',
              requesting_human: false,
              source: 'web'
            });
            console.log(`💾 Created chat session in database: ${chatId}`);
          }
        } catch (error) {
          console.error(`❌ Exception creating chat session:`, error);
        }
      }
      
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

    // Store user message
    const userMessage: Message = {
      from: "user",
      text,
      timestamp: Date.now()
    };
    storeMessage(chatId, userMessage, userId);

    // Broadcast to all clients
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
    await handleBotReply(chatId, text, "web");
  });

  // Handle user info updates
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

  // Handle explicit human support request
  socket.on("request_human_support", ({ chatId }: { chatId: string }) => {
    console.log(`🙋 Human support requested from ${chatId}`);
    
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard("human_support_requested", { chatId });
      sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.", chat.source);
    }
  });

  // Alternative event name
  socket.on("request_human", ({ chatId }: { chatId: string }) => {
    console.log(`🙋 Human support requested from ${chatId} (via request_human)`);
    
    const chat = activeChats.get(chatId);
    if (chat) {
      chat.requestingHuman = true;
      emitToDashboard("human_support_requested", { chatId });
      sendBotMessage(chatId, "🙋 I've notified our support team. An agent will join you shortly.", chat.source);
    }
  });

  // Dashboard sends message via socket
  socket.on("send_message", async ({ chatId, message, agentId, agentName }) => {
    const chat = activeChats.get(String(chatId));
    
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
      storeMessage(String(chatId), agentMessage, chat?.userId);
      
      emitToDashboard("message_from_agent", { chatId, message, agentId, agentName });
      console.log(`👨‍💼 Agent ${agentName || agentId} sent message via socket to ${chatId}`);
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
        } catch (error) {
          console.error(`❌ Failed to update chat session:`, error);
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

  // Release via socket
  socket.on("release", async ({ chatId }) => {
    const chat = activeChats.get(String(chatId));
    if (chat) {
      chat.mode = "bot";
      delete chat.agentId;
      delete chat.agentName;
      chat.requestingHuman = false;
      
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
        } catch (error) {
          console.error(`❌ Failed to update chat session:`, error);
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

// =====================================================
// SERVER STARTUP
// =====================================================
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🌐 Frontend origin: ${FRONTEND_ORIGIN}`);
  console.log(`📱 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`💬 Two-bot mode: Customer + Support agents via Telegram`);
  console.log(`🔌 Socket.IO enabled for real-time dashboard`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
