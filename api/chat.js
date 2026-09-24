import { callDeepSeekWeb } from "../lib/deepseek-web-client.js";

export default async function handler(req, res) {
  const { dsToken, messages, model } = req.body || {};
  if (!dsToken || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Add your DeepSeek web token in Settings first." });
  }
  try {
    const result = await callDeepSeekWeb({
      dsToken,
      messages: messages.map((m) => ({ role: m.role, content: String(m.content || "") })),
      model: model || "deepseek-chat",
    });
    return res.status(200).json({
      content: result?.choices?.[0]?.message?.content || "",
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || String(error) });
  }
}
