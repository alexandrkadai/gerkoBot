import OpenAI from "openai";
import dotenv from "dotenv";

// Ensure environment variables are loaded
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in environment variables");
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

export async function getAIReply(userMessage: string): Promise<string> {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { 
          role: "system", 
          content: "You are a helpful support assistant for a customer service platform. Be concise, friendly, and helpful. If you can't answer something, suggest contacting a human agent." 
        },
        { role: "user", content: userMessage }
      ],
      max_tokens: 150,
      temperature: 0.7
    });

    const aiResponse = response.choices[0]?.message?.content?.trim();
    
    if (!aiResponse) {
      return "🤖 Sorry, I don't have an answer right now. Would you like to speak with a human agent?";
    }
    
    return aiResponse;
    
  } catch (err: any) {
    console.error("❌ OpenAI API error:", err);
    
    // Handle specific OpenAI errors
    if (err?.error?.code === 'insufficient_quota') {
      return "🤖 I'm temporarily unavailable due to quota limits. Please contact a human agent for assistance.";
    } else if (err?.error?.code === 'rate_limit_exceeded') {
      return "🤖 I'm receiving too many requests. Please wait a moment or contact a human agent.";
    }
    
    return "🤖 Sorry, I couldn't process your request at the moment. Would you like to speak with a human agent?";
  }
}