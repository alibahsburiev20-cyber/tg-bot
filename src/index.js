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
  const feeds = [
    "https://cointelegraph.com/rss",
    "https://www.coindesk.com/arc/outboundfeeds/rss",
    "https://decrypt.co/feed",
    "https://news.bitcoin.com/feed",
  ];

  let allItems = [];
  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const xml = await res.text();
      const items = parseRSSItems(xml, 6);
      allItems = allItems.concat(items);
    } catch (e) {
      // если один источник недоступен - пропускаем, остальные всё равно дадут новости
    }
  }

  // Перемешиваем, чтобы не всегда брать в одном порядке источников
  allItems.sort(() => Math.random() - 0.5);

  const withFullText = [];
  for (const item of allItems.slice(0, 12)) {
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

async function publishToChannelWithPhoto(botToken, chatUsername, text, imageBase64) {
  const formData = new FormData();
  formData.append("chat_id", chatUsername);
  formData.append("caption", text);
  const bytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
  formData.append("photo", new Blob([bytes], { type: "image/png" }), "post.png");

  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const res = await fetch(url, { method: "POST", body: formData });
  return res.json();
}

async function publishToChannel(botToken, chatUsername, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatUsername,
      text: text,
    }),
  });
  return res.json();
}

// Обрабатывает контент для ОДНОГО конкретного канала (config уже содержит user_id, bot_token и т.д.)
async function postScheduledContentForChannel(env, config) {
  const recent = await env.DB.prepare(
    "SELECT topic_tags FROM content_log WHERE channel_id = ? ORDER BY published_at DESC LIMIT 15"
  ).bind(config.id).all();
  const recentTopics = recent.results.map(r => r.topic_tags).filter(Boolean);

  const postText = await generatePost(env, config.niche, config.tone, recentTopics);
  const topic = await extractTopic(env, postText);
  const tgResult = await publishToChannel(config.bot_token, config.channel_username, postText);

  await env.DB.prepare(
    "INSERT INTO content_log (post_text, topic_tags, user_id, channel_id) VALUES (?, ?, ?, ?)"
  ).bind(postText, topic, config.user_id, config.id).run();

  return { posted: true, topic, telegram: tgResult };
}

async function postScheduledNewsContentForChannel(env, config) {
  const recent = await env.DB.prepare(
    "SELECT topic_tags, post_text FROM content_log WHERE channel_id = ? ORDER BY published_at DESC LIMIT 20"
  ).bind(config.id).all();
  const recentTopics = recent.results.map(r => r.topic_tags).filter(Boolean);
  const recentTextsLower = recent.results.map(r => (r.post_text || "").toLowerCase());

  let newsItems = await fetchNews(config.niche);
  if (newsItems.length === 0) return { error: "no news fetched" };

  newsItems = newsItems.filter(n => {
    const titleWords = n.title.toLowerCase().split(/\s+/).filter(w => w.length > 5);
    const overlapCount = titleWords.filter(w => recentTextsLower.some(t => t.includes(w))).length;
    return overlapCount < 2;
  });

  if (newsItems.length === 0) {
    return await postScheduledContentForChannel(env, config);
  }

  const postText = await generateNewsPost(env, config.niche, config.tone, recentTopics, newsItems);
  const topic = await extractTopic(env, postText);

  let tgResult;
  try {
    const imagePrompt = await generateImagePrompt(env, postText);
    const imageBase64 = await generateImage(env, imagePrompt);
    tgResult = await publishToChannelWithPhoto(config.bot_token, config.channel_username, postText, imageBase64);
  } catch (e) {
    tgResult = await publishToChannel(config.bot_token, config.channel_username, postText);
  }

  await env.DB.prepare(
    "INSERT INTO content_log (post_text, topic_tags, user_id, channel_id) VALUES (?, ?, ?, ?)"
  ).bind(postText, topic, config.user_id, config.id).run();

  return { posted: true, topic, source: "news", telegram: tgResult };
}

// Обёртки для ручного вызова через API одним конкретным юзером (по userId из сессии)
async function postScheduledContent(env, userId) {
  const config = await env.DB.prepare("SELECT * FROM channel_config WHERE user_id = ? LIMIT 1").bind(userId).first();
  if (!config) return { error: "no channel config found" };
  if (!config.bot_token) return { error: "bot token not set" };
  return postScheduledContentForChannel(env, config);
}

async function postScheduledNewsContent(env, userId) {
  const config = await env.DB.prepare("SELECT * FROM channel_config WHERE user_id = ? LIMIT 1").bind(userId).first();
  if (!config) return { error: "no channel config found" };
  if (!config.bot_token) return { error: "bot token not set" };
  return postScheduledNewsContentForChannel(env, config);
}

// Проходит по ВСЕМ пользователям сервиса - вызывается из cron
async function postScheduledNewsContentForAllUsers(env) {
  const channels = await env.DB.prepare("SELECT * FROM channel_config WHERE bot_token IS NOT NULL").all();
  const results = [];
  for (const config of channels.results) {
    try {
      const r = await postScheduledNewsContentForChannel(env, config);
      results.push({ user_id: config.user_id, ...r });
    } catch (e) {
      results.push({ user_id: config.user_id, error: String(e) });
    }
  }
  return { processed: results.length, results };
}

async function postAdsToChats(env) {
  const now = new Date();
  const dueChats = await env.DB.prepare(
    `SELECT * FROM ad_chats WHERE last_posted_at IS NULL
     OR datetime(last_posted_at, '+' || frequency_hours || ' hours') <= datetime(?)`
  ).bind(now.toISOString()).all();

  const results = [];
  for (const chat of dueChats.results) {
    const config = chat.channel_id
      ? await env.DB.prepare("SELECT bot_token FROM channel_config WHERE id = ?").bind(chat.channel_id).first()
      : await env.DB.prepare("SELECT bot_token FROM channel_config WHERE user_id = ? LIMIT 1").bind(chat.user_id).first();
    const texts = await env.DB.prepare("SELECT * FROM ad_texts WHERE user_id = ?").bind(chat.user_id).all();
    if (!config || !config.bot_token || texts.results.length === 0) continue;

    const variant = texts.results[Math.floor(Math.random() * texts.results.length)];
    const url = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
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

async function verifyTelegramAuth(authData, botToken) {
  const { hash, ...data } = authData;
  const checkString = Object.keys(data)
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.digest("SHA-256", encoder.encode(botToken));
  const key = await crypto.subtle.importKey(
    "raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(checkString));
  const computedHash = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");

  const authAge = Math.floor(Date.now() / 1000) - data.auth_date;
  return computedHash === hash && authAge < 86400;
}

async function getOrCreateUser(env, telegramData) {
  let user = await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(String(telegramData.id)).first();
  if (!user) {
    await env.DB.prepare(
      "INSERT INTO users (telegram_id, telegram_username, first_name) VALUES (?, ?, ?)"
    ).bind(String(telegramData.id), telegramData.username || "", telegramData.first_name || "").run();
    user = await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(String(telegramData.id)).first();
  }
  return user;
}

// Простая сессия: подписанный токен вида "userId.signature", хранится в cookie
async function createSessionToken(userId, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(userId)));
  const sigHex = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${userId}.${sigHex}`;
}

async function verifySessionToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [userId, sig] = token.split(".");
  const expected = await createSessionToken(userId, secret);
  return expected === token ? parseInt(userId) : null;
}

function getSessionUserId(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  return verifySessionToken(match[1], env.TELEGRAM_BOT_TOKEN);
}

async function getSubscriberCount(botToken, channelUsername) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getChatMemberCount?chat_id=${encodeURIComponent(channelUsername)}`;
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

  // POST /api/auth/telegram - вход через Telegram Login Widget
  if (path === "/api/auth/telegram" && method === "POST") {
    const authData = await request.json();
    const valid = await verifyTelegramAuth(authData, env.TELEGRAM_BOT_TOKEN);
    if (!valid) return Response.json({ error: "invalid auth" }, { status: 401 });

    const user = await getOrCreateUser(env, authData);
    const token = await createSessionToken(user.id, env.TELEGRAM_BOT_TOKEN);
    return new Response(JSON.stringify({ ok: true, user }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      },
    });
  }

  // GET /api/auth/me - кто я
  if (path === "/api/auth/me" && method === "GET") {
    const userId = await getSessionUserId(request, env);
    if (!userId) return Response.json({ user: null });
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
    return Response.json({ user: user || null });
  }

  // Все эндпоинты ниже требуют сессию
  const userId = await getSessionUserId(request, env);
  if (!userId && path.startsWith("/api/")) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  // GET /api/channels - список всех каналов пользователя
  if (path === "/api/channels" && method === "GET") {
    const channels = await env.DB.prepare("SELECT id, channel_username, niche FROM channel_config WHERE user_id = ? ORDER BY id").bind(userId).all();
    return Response.json({ channels: channels.results });
  }

  // GET /api/dashboard?channel_id=N
  if (path === "/api/dashboard" && method === "GET") {
    const channelId = url.searchParams.get("channel_id");
    const config = channelId
      ? await env.DB.prepare("SELECT * FROM channel_config WHERE user_id = ? AND id = ?").bind(userId, channelId).first()
      : await env.DB.prepare("SELECT * FROM channel_config WHERE user_id = ? ORDER BY id LIMIT 1").bind(userId).first();
    const posts = config ? await env.DB.prepare(
      "SELECT * FROM content_log WHERE user_id = ? AND channel_id = ? ORDER BY published_at DESC LIMIT 10"
    ).bind(userId, config.id).all() : { results: [] };
    const postsCountRow = config ? await env.DB.prepare("SELECT COUNT(*) as c FROM content_log WHERE user_id = ? AND channel_id = ?").bind(userId, config.id).first() : { c: 0 };
    const chatsCountRow = config ? await env.DB.prepare("SELECT COUNT(*) as c FROM ad_chats WHERE user_id = ? AND channel_id = ?").bind(userId, config.id).first() : { c: 0 };
    const subscribers = (config && config.bot_token) ? await getSubscriberCount(config.bot_token, config.channel_username) : null;

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
    const channelId = url.searchParams.get("channel_id");
    const config = channelId
      ? await env.DB.prepare("SELECT * FROM channel_config WHERE user_id = ? AND id = ?").bind(userId, channelId).first()
      : await env.DB.prepare("SELECT * FROM channel_config WHERE user_id = ? ORDER BY id LIMIT 1").bind(userId).first();
    if (config) { config.bot_token_set = !!config.bot_token; delete config.bot_token; }
    return Response.json({ config: config || null });
  }
  if (path === "/api/channel-config" && method === "POST") {
    const body = await request.json();
    const existing = body.channel_id
      ? await env.DB.prepare("SELECT id, bot_token FROM channel_config WHERE user_id = ? AND id = ?").bind(userId, body.channel_id).first()
      : null;
    const botToken = body.bot_token || (existing ? existing.bot_token : null);
    if (existing) {
      await env.DB.prepare(
        "UPDATE channel_config SET channel_username=?, niche=?, tone=?, posts_per_day=?, bot_token=? WHERE id=?"
      ).bind(body.channel_username, body.niche, body.tone, body.posts_per_day, botToken, existing.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO channel_config (channel_username, niche, tone, posts_per_day, bot_token, user_id) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(body.channel_username, body.niche, body.tone, body.posts_per_day, botToken, userId).run();
    }
    return Response.json({ ok: true });
  }

  // GET/POST /api/chats
  if (path === "/api/chats" && method === "GET") {
    const channelId = url.searchParams.get("channel_id");
    const chats = channelId
      ? await env.DB.prepare("SELECT * FROM ad_chats WHERE user_id = ? AND channel_id = ? ORDER BY id DESC").bind(userId, channelId).all()
      : await env.DB.prepare("SELECT * FROM ad_chats WHERE user_id = ? ORDER BY id DESC").bind(userId).all();
    return Response.json({ chats: chats.results });
  }
  if (path === "/api/chats" && method === "POST") {
    const body = await request.json();
    const config = await env.DB.prepare("SELECT id FROM channel_config WHERE user_id = ? ORDER BY id LIMIT 1").bind(userId).first();
    await env.DB.prepare(
      "INSERT INTO ad_chats (chat_id, chat_title, frequency_hours, user_id, channel_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(body.chat_id, body.chat_title || "", body.frequency_hours || 30, userId, config ? config.id : null).run();
    return Response.json({ ok: true });
  }
  // DELETE /api/chats/:id
  const chatDeleteMatch = path.match(/^\/api\/chats\/(\d+)$/);
  if (chatDeleteMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM ad_chats WHERE id = ? AND user_id = ?").bind(chatDeleteMatch[1], userId).run();
    return Response.json({ ok: true });
  }

  // GET/POST /api/ad-texts
  if (path === "/api/ad-texts" && method === "GET") {
    const texts = await env.DB.prepare("SELECT * FROM ad_texts WHERE user_id = ? ORDER BY id DESC").bind(userId).all();
    return Response.json({ texts: texts.results });
  }
  if (path === "/api/ad-texts" && method === "POST") {
    const body = await request.json();
    await env.DB.prepare(
      "INSERT INTO ad_texts (text_variant, user_id) VALUES (?, ?)"
    ).bind(body.text_variant, userId).run();
    return Response.json({ ok: true });
  }
  const textDeleteMatch = path.match(/^\/api\/ad-texts\/(\d+)$/);
  if (textDeleteMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM ad_texts WHERE id = ? AND user_id = ?").bind(textDeleteMatch[1], userId).run();
    return Response.json({ ok: true });
  }

  // GET /api/agent-recommendations

  if (path === "/api/agent-recommendations" && method === "GET") {
    const recommendations = [];

    // Правило 1: чат с ошибкой при последнем постинге -> предложить удалить
    const errorChats = await env.DB.prepare(
      "SELECT * FROM ad_chats WHERE last_status = 'error' AND user_id = ?"
    ).bind(userId).all();
    for (const chat of errorChats.results) {
      recommendations.push({
        title: `Чат "${chat.chat_title || chat.chat_id}" не принимает посты`,
        reason: "Последняя попытка публикации завершилась ошибкой (бот не добавлен или нет прав). Предлагаю убрать его из списка.",
        action: "delete_chat",
        targetId: chat.id,
      });
    }

    // Правило 2: меньше 3 вариантов текста объявления -> предложить добавить
    const textsCount = await env.DB.prepare("SELECT COUNT(*) as c FROM ad_texts WHERE user_id = ?").bind(userId).first();
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
      await env.DB.prepare("DELETE FROM ad_chats WHERE id = ? AND user_id = ?").bind(body.targetId, userId).run();
    }
    return Response.json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Ручной запуск - только для авторизованного пользователя, публикует в ЕГО канал
    if (url.pathname === "/run-content" || url.pathname === "/run-news-content") {
      const userId = await getSessionUserId(request, env);
      if (!userId) return Response.json({ error: "not authenticated" }, { status: 401 });
      const result = url.pathname === "/run-content"
        ? await postScheduledContent(env, userId)
        : await postScheduledNewsContent(env, userId);
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
      "/app/login": "/app/login.html",
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

  // Cron проходит по ВСЕМ пользователям сервиса: публикует новостной пост в каждый канал + объявления в чаты
  async scheduled(event, env, ctx) {
    ctx.waitUntil(postScheduledNewsContentForAllUsers(env));
    ctx.waitUntil(postAdsToChats(env));
  },
};
