// Worker: автопостинг контента в Telegram-канал + постинг объявлений в чаты-биржи
// Требует секреты: TELEGRAM_BOT_TOKEN
// Требует binding: DB (D1), AI (Workers AI)

async function generatePost(env, niche, tone, recentTopics) {
  const avoidList = recentTopics.length > 0
    ? `Уже писал про: ${recentTopics.join("; ")}. Выбери СОВСЕМ ДРУГУЮ тему, не касайся тех же монет/понятий.`
    : "Это первый пост, выбери любую конкретную тему.";

  const prompt = `Ты ведёшь Telegram-канал на тему "${niche}". Стиль: ${tone || "экспертный, но живой"}.
${avoidList}
Возьми узкую конкретную подтему (не общий обзор "что такое крипта", а что-то конкретное: конкретный инструмент, конкретная ошибка новичков, конкретное событие, конкретный термин, конкретная монета/платформа).
Напиши один пост на 100-150 слов.
Ответь только текстом поста, без преамбулы, без кавычек, без фразы "Привет всем" в начале — сразу с сути.`;

  const response = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
  });
  return (response.response || "").trim();
}

async function extractTopic(env, postText) {
  const response = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
    messages: [{ role: "user", content: `Назови тему этого поста 2-4 словами (например "хранение крипты в холодных кошельках"), без кавычек и пояснений:\n\n${postText}` }],
    temperature: 0.3,
  });
  return (response.response || postText.slice(0, 50)).trim();
}

// Простой парсер RSS через регулярки (без внешних библиотек)
function parseRSSItems(xml, limit = 5) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1, limit + 1);
  for (const block of itemBlocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const description = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
    items.push({
      title: title.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
      link: link.trim(),
      description: description.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim(),
    });
  }
  return items;
}

// Вытаскивает основной текст статьи из HTML-страницы (грубо, по тегам <p>)
async function fetchArticleText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, "").trim())
      .filter(p => p.length > 40);
    return paragraphs.slice(0, 8).join(" ").slice(0, 3000);
  } catch (e) {
    return "";
  }
}

async function fetchNews(niche) {
  const feedUrl = "https://cointelegraph.com/rss";
  const res = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  const xml = await res.text();
  const items = parseRSSItems(xml, 5);

  const withFullText = [];
  for (const item of items) {
    const fullText = await fetchArticleText(item.link);
    withFullText.push({ ...item, fullText: fullText || item.description });
  }
  return withFullText;
}

async function generateNewsPost(env, niche, tone, recentTopics, newsItems) {
  const newsBlock = newsItems
    .map((n, i) => `[Новость ${i + 1}] Заголовок: ${n.title}\nТекст: ${n.fullText}`)
    .join("\n\n");

  const avoidList = recentTopics.length > 0
    ? `Уже писал про: ${recentTopics.join("; ")}. Если все новости пересекаются с этим — выбери ту, что меньше всего пересекается.`
    : "";

  const prompt = `Ты ведёшь Telegram-канал на тему "${niche}". Стиль: ${tone || "экспертный, но живой"}.
Вот несколько свежих новостей:

${newsBlock}

Выбери ОДНУ самую значимую и интересную для аудитории новость. Напиши по ней пост на 100-150 слов:
- Перескажи суть ПОЛНОСТЬЮ СВОИМИ СЛОВАМИ, не используй дословные фразы или предложения из текста новости
- Структура: что произошло → почему это важно для читателя → короткий вывод/что это значит на практике
${avoidList}
Ответь только текстом поста, без преамбулы, без кавычек, без ссылок на источник в тексте.`;

  const response = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });
  return (response.response || "").trim();
}

async function generateImagePrompt(env, postText) {
  const response = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
    messages: [{ role: "user", content: `Опиши короткую сцену для иллюстрации к этому посту, на английском, 1-2 предложения, в стиле "digital art, clean, professional" (без текста/букв на картинке):\n\n${postText}` }],
    temperature: 0.7,
  });
  return (response.response || "abstract digital art about finance and technology").trim();
}

async function generateImage(env, imagePrompt) {
  const result = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
    prompt: imagePrompt,
  });
  // flux-1-schnell возвращает { image: "base64..." }
  return result.image;
}

async function publishToChannelWithPhoto(env, text, imageBase64) {
  const formData = new FormData();
  formData.append("chat_id", env.CHANNEL_USERNAME);
  formData.append("caption", text);
  const bytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
  formData.append("photo", new Blob([bytes], { type: "image/png" }), "post.png");

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, { method: "POST", body: formData });
  return res.json();
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
    "SELECT topic_tags FROM content_log ORDER BY published_at DESC LIMIT 15"
  ).all();
  const recentTopics = recent.results.map(r => r.topic_tags).filter(Boolean);

  const postText = await generatePost(env, config.niche, config.tone, recentTopics);
  const topic = await extractTopic(env, postText);
  const tgResult = await publishToChannel(env, postText);

  await env.DB.prepare(
    "INSERT INTO content_log (post_text, topic_tags) VALUES (?, ?)"
  ).bind(postText, topic).run();

  return { posted: true, topic, telegram: tgResult };
}

async function postScheduledNewsContent(env) {
  const config = await env.DB.prepare("SELECT * FROM channel_config LIMIT 1").first();
  if (!config) return { error: "no channel config found" };

  const recent = await env.DB.prepare(
    "SELECT topic_tags FROM content_log ORDER BY published_at DESC LIMIT 15"
  ).all();
  const recentTopics = recent.results.map(r => r.topic_tags).filter(Boolean);

  const newsItems = await fetchNews(config.niche);
  if (newsItems.length === 0) return { error: "no news fetched" };

  const postText = await generateNewsPost(env, config.niche, config.tone, recentTopics, newsItems);
  const topic = await extractTopic(env, postText);

  let tgResult;
  try {
    const imagePrompt = await generateImagePrompt(env, postText);
    const imageBase64 = await generateImage(env, imagePrompt);
    tgResult = await publishToChannelWithPhoto(env, postText, imageBase64);
  } catch (e) {
    // если генерация картинки упала - публикуем хотя бы текстом
    tgResult = await publishToChannel(env, postText);
  }

  await env.DB.prepare(
    "INSERT INTO content_log (post_text, topic_tags) VALUES (?, ?)"
  ).bind(postText, topic).run();

  return { posted: true, topic, source: "news", telegram: tgResult };
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
    const status = json.ok ? "ok" : "error";
    await env.DB.prepare(
      "UPDATE ad_chats SET last_posted_at = ?, last_status = ? WHERE id = ?"
    ).bind(now.toISOString(), status, chat.id).run();
    results.push({ chat: chat.chat_title, ok: json.ok });
  }
  return { posted_to: results.length, results };
}

async function getSubscriberCount(env, channelUsername) {
  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMemberCount?chat_id=${encodeURIComponent(channelUsername)}`;
    const res = await fetch(url);
    const json = await res.json();
    return json.ok ? json.result : null;
  } catch (e) {
    return null;
  }
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // GET /api/dashboard
  if (path === "/api/dashboard" && method === "GET") {
    const config = await env.DB.prepare("SELECT * FROM channel_config LIMIT 1").first();
    const posts = await env.DB.prepare(
      "SELECT * FROM content_log ORDER BY published_at DESC LIMIT 10"
    ).all();
    const postsCountRow = await env.DB.prepare("SELECT COUNT(*) as c FROM content_log").first();
    const chatsCountRow = await env.DB.prepare("SELECT COUNT(*) as c FROM ad_chats").first();
    const subscribers = config ? await getSubscriberCount(env, config.channel_username) : null;

    return Response.json({
      channel: config || null,
      posts: posts.results,
      postsCount: postsCountRow.c,
      chatsCount: chatsCountRow.c,
      subscribers,
    });
  }

  // GET/POST /api/channel-config
  if (path === "/api/channel-config" && method === "GET") {
    const config = await env.DB.prepare("SELECT * FROM channel_config LIMIT 1").first();
    return Response.json({ config: config || null });
  }
  if (path === "/api/channel-config" && method === "POST") {
    const body = await request.json();
    const existing = await env.DB.prepare("SELECT id FROM channel_config LIMIT 1").first();
    if (existing) {
      await env.DB.prepare(
        "UPDATE channel_config SET channel_username=?, niche=?, tone=?, posts_per_day=? WHERE id=?"
      ).bind(body.channel_username, body.niche, body.tone, body.posts_per_day, existing.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO channel_config (channel_username, niche, tone, posts_per_day) VALUES (?, ?, ?, ?)"
      ).bind(body.channel_username, body.niche, body.tone, body.posts_per_day).run();
    }
    return Response.json({ ok: true });
  }

  // GET/POST /api/chats
  if (path === "/api/chats" && method === "GET") {
    const chats = await env.DB.prepare("SELECT * FROM ad_chats ORDER BY id DESC").all();
    return Response.json({ chats: chats.results });
  }
  if (path === "/api/chats" && method === "POST") {
    const body = await request.json();
    await env.DB.prepare(
      "INSERT INTO ad_chats (chat_id, chat_title, frequency_hours) VALUES (?, ?, ?)"
    ).bind(body.chat_id, body.chat_title || "", body.frequency_hours || 30).run();
    return Response.json({ ok: true });
  }
  // DELETE /api/chats/:id
  const chatDeleteMatch = path.match(/^\/api\/chats\/(\d+)$/);
  if (chatDeleteMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM ad_chats WHERE id = ?").bind(chatDeleteMatch[1]).run();
    return Response.json({ ok: true });
  }

  // GET/POST /api/ad-texts
  if (path === "/api/ad-texts" && method === "GET") {
    const texts = await env.DB.prepare("SELECT * FROM ad_texts ORDER BY id DESC").all();
    return Response.json({ texts: texts.results });
  }
  if (path === "/api/ad-texts" && method === "POST") {
    const body = await request.json();
    await env.DB.prepare(
      "INSERT INTO ad_texts (text_variant) VALUES (?)"
    ).bind(body.text_variant).run();
    return Response.json({ ok: true });
  }
  const textDeleteMatch = path.match(/^\/api\/ad-texts\/(\d+)$/);
  if (textDeleteMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM ad_texts WHERE id = ?").bind(textDeleteMatch[1]).run();
    return Response.json({ ok: true });
  }

  // GET /api/agent-recommendations
  if (path === "/api/agent-recommendations" && method === "GET") {
    const recommendations = [];

    // Правило 1: чат с ошибкой при последнем постинге -> предложить удалить
    const errorChats = await env.DB.prepare(
      "SELECT * FROM ad_chats WHERE last_status = 'error'"
    ).all();
    for (const chat of errorChats.results) {
      recommendations.push({
        title: `Чат "${chat.chat_title || chat.chat_id}" не принимает посты`,
        reason: "Последняя попытка публикации завершилась ошибкой (бот не добавлен или нет прав). Предлагаю убрать его из списка.",
        action: "delete_chat",
        targetId: chat.id,
      });
    }

    // Правило 2: меньше 3 вариантов текста объявления -> предложить добавить
    const textsCount = await env.DB.prepare("SELECT COUNT(*) as c FROM ad_texts").first();
    if (textsCount.c < 3) {
      recommendations.push({
        title: "Мало вариантов текста объявлений",
        reason: `Сейчас всего ${textsCount.c} вариант(ов) — ротация работает слабо, тексты быстро примелькаются. Добавь ещё 2-3.`,
        action: "none",
        targetId: 0,
      });
    }

    return Response.json({ recommendations });
  }

  // POST /api/agent-recommendations/apply
  if (path === "/api/agent-recommendations/apply" && method === "POST") {
    const body = await request.json();
    if (body.action === "delete_chat") {
      await env.DB.prepare("DELETE FROM ad_chats WHERE id = ?").bind(body.targetId).run();
    }
    return Response.json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/run-content") {
      const result = await postScheduledContent(env);
      return Response.json(result);
    }
    if (url.pathname === "/run-news-content") {
      const result = await postScheduledNewsContent(env);
      return Response.json(result);
    }
    if (url.pathname === "/run-ads") {
      const result = await postAdsToChats(env);
      return Response.json(result);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (url.pathname === "/") {
      return Response.redirect(url.origin + "/app/", 302);
    }

    // Маппинг чистых URL страниц на конкретные .html файлы
    const pageMap = {
      "/app/": "/app/index.html",
      "/app/settings": "/app/settings.html",
      "/app/chats": "/app/chats.html",
      "/app/ad-texts": "/app/ad-texts.html",
      "/app/agents": "/app/agents.html",
    };
    if (pageMap[url.pathname]) {
      const assetUrl = new URL(pageMap[url.pathname], url.origin);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Раздача статики (style.css и прочее) через Assets binding
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(postScheduledNewsContent(env));
  },
};
