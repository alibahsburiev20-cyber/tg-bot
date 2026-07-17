// Worker: автопостинг контента в Telegram-канал + постинг объявлений в чаты-биржи
// Требует секреты: TELEGRAM_BOT_TOKEN
// Требует binding: DB (D1), AI (Workers AI)

async function generatePost(env, niche, tone, recentTopics) {
  const prompt = `Ты ведёшь Telegram-канал на тему "${niche}". Стиль: ${tone || "экспертный, но живой"}.
Напиши один пост на 100-150 слов. Не повторяй темы: ${recentTopics.join(", ") || "нет предыдущих тем"}.
Ответь только текстом поста, без преамбулы и кавычек.`;

  const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });
  return response.response.trim();
}

async function publishToChannel(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.CHANNEL_USERNAME,
      text: text,
    }),
  });
  return res.json();
}

async function postScheduledContent(env) {
  const config = await env.DB.prepare("SELECT * FROM channel_config LIMIT 1").first();
  if (!config) return { error: "no channel config found" };

  const recent = await env.DB.prepare(
    "SELECT topic_tags FROM content_log ORDER BY published_at DESC LIMIT 5"
  ).all();
  const recentTopics = recent.results.map(r => r.topic_tags).filter(Boolean);

  const postText = await generatePost(env, config.niche, config.tone, recentTopics);
  const tgResult = await publishToChannel(env, postText);

  await env.DB.prepare(
    "INSERT INTO content_log (post_text, topic_tags) VALUES (?, ?)"
  ).bind(postText, postText.slice(0, 50)).run();

  return { posted: true, telegram: tgResult };
}

async function postAdsToChats(env) {
  const now = new Date();
  const dueChats = await env.DB.prepare(
    `SELECT * FROM ad_chats WHERE last_posted_at IS NULL
     OR datetime(last_posted_at, '+' || frequency_hours || ' hours') <= datetime(?)`
  ).bind(now.toISOString()).all();

  const texts = await env.DB.prepare("SELECT * FROM ad_texts").all();
  if (texts.results.length === 0) return { error: "no ad texts configured" };

  const results = [];
  for (const chat of dueChats.results) {
    const variant = texts.results[Math.floor(Math.random() * texts.results.length)];
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat.chat_id, text: variant.text_variant }),
    });
    const json = await res.json();
    await env.DB.prepare(
      "UPDATE ad_chats SET last_posted_at = ? WHERE id = ?"
    ).bind(now.toISOString(), chat.id).run();
    results.push({ chat: chat.chat_title, ok: json.ok });
  }
  return { posted_to: results.length, results };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run-content") {
      const result = await postScheduledContent(env);
      return Response.json(result);
    }
    if (url.pathname === "/run-ads") {
      const result = await postAdsToChats(env);
      return Response.json(result);
    }
    return new Response("Worker is running. Endpoints: /run-content, /run-ads");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(postScheduledContent(env));
  },
};
