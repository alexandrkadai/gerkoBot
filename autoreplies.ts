// autoReplies.ts

interface AutoReply {
  keywords: string[];
  reply: string;
}

export const autoReplies: AutoReply[] = [
  {
    keywords: ["hello", "hi", "hey"],
    reply: "👋 Hi there! I’m your virtual assistant. How can I help today?",
  },
  {
    keywords: ["price", "cost", "payment", "subscribe", "pricing", "plan", "plans"],
    reply: "💸 Our pricing plans: Starter $49/month (up to 500 patients), Professional $99/month (unlimited patients, AI automation) 🌟 Popular, Premium $199/month (up to 12 practitioners), Enterprise (custom pricing for 12+ practitioners). All plans include free trial!",
  },
  {
    keywords: ["support", "help", "problem", "issue"],
    reply: "🧑‍💻 I can guide you with basic support. If you want a human agent, just type *agent*.",
  },
  {
    keywords: ["hours", "time", "open", "schedule"],
    reply: "⏰ Our support team is available 24/7 via chat or email.",
  },
  {
    keywords: ["bye", "thanks", "thank you"],
    reply: "🙏 You're welcome! Feel free to reach out anytime.",
  },
];
