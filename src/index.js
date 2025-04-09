const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const { CozeAPI } = require("@coze/api");
require("dotenv").config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const COZE_BOT_ID = process.env.COZE_BOT_ID;
const COZE_API_TOKEN = process.env.COZE_API_TOKEN_v2;
const COZE_USER_ID = process.env.COZE_USER_ID;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const apiClient = new CozeAPI({
  token: COZE_API_TOKEN,
  baseURL: "https://api.coze.com",
});

// Хранилище данных для каждого чата
const chatData = {};

// Функция для отправки группы изображений
async function sendGroupImage(chatId, photoPath) {
  try {
    const media = [];

    photoPath.forEach((image) =>
      media.push({
        type: "photo",
        media: image,
      })
    );

    await bot.sendMediaGroup(chatId, media);

    // Удаляем временные файлы
    media.forEach((file) => {
      fs.unlink(file.media, (error) => {
        if (error) console.error("Ошибка при удалении файла:", error);
      });
    });
    console.log("Временные файлы фотографий удалены");
  } catch (error) {
    console.error("Ошибка при отправке альбома:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при отправке альбома.");
  }
}

// Удаление эмодзи и лишних символов
function cleanText(text) {
  const regExp =
    /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDE4F]|\uD83D[\uDE80-\uDEFF]|\uD83E[\uDD10-\uDDFF]|\n)/g;
  return text.replace(regExp, "");
}

// Поиск изображений
async function searchPhoto(msg) {
  if (!msg.photo) return null;

  const photoPath = await bot.downloadFile(
    msg.photo[msg.photo.length - 1].file_id,
    "./images"
  );
  return photoPath;
}

// Поиск ссылок
async function searchLinks(msg) {
  if (!msg.caption_entities) return null;

  const links = [];
  msg.caption_entities.forEach((entity) => {
    if (entity.type === "text_link") {
      const fragmentText = msg.caption.substr(entity.offset, entity.length);
      links.push({ url: entity.url, context: `"${fragmentText}"` });
    }
  });

  return links.length > 0 ? links : null;
}

async function sendTextToCoze(text) {
  try {
    // Отправляем запрос в Coze
    const initialResponse = await apiClient.chat.createAndPoll({
      bot_id: COZE_BOT_ID,
      user_id: COZE_USER_ID,
      additional_messages: [
        {
          content: text,
          content_type: "text",
          role: "user",
        },
      ],
    });

    if (initialResponse.chat.status === "completed") {
      return initialResponse.messages[0].content;
    } else {
      throw new Error(`Неожиданный статус: ${initialResponse}`);
    }
  } catch (error) {
    console.error(
      "Ошибка при запросе к Coze:",
      error.response?.data || error.message
    );
    throw new Error("Не удалось получить ответ от Coze.");
  }
}

// Обработка текстовых сообщений
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const messageText =
    msg.forward_from_chat?.type === "channel" ? msg.caption : msg.text;

  // Инициализация данных для чата
  if (!chatData[chatId]) {
    chatData[chatId] = {
      posts: [],
      isCollecting: false,
    };
  }

  try {
    if (messageText === "/start") {
      await bot.sendMessage(
        chatId,
        "Привет! Отправь мне текст или пост для анализа."
      );
    }
    // Начало сбора нескольких постов
    else if (messageText === "/start_collecting") {
      chatData[chatId].isCollecting = true;
      chatData[chatId].posts = [];
      console.log("Начат сбор нескольких постов..");
      await bot.sendMessage(
        chatId,
        "Отправь мне посты для анализа, затем нажми кнопку 'Закончить сбор'",
        {
          reply_markup: {
            keyboard: [["❌ Закончить сбор информации"]],
            resize_keyboard: true,
          },
        }
      );
    }
    // Завершение сбора постов
    else if (messageText === "❌ Закончить сбор информации") {
      await finishCollection(chatId);
    }
    // Обработка пересланного поста в режиме сбора
    else if (chatData[chatId].isCollecting && msg.forward_from_chat) {
      await processPost(chatId, msg);
    }
    // Обработка одиночного поста
    else if (messageText && !chatData[chatId].isCollecting) {
      await bot.sendMessage(chatId, "Обрабатываю...");
      await processSingleMessage(chatId, msg);
    }
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, "Произошла ошибка при анализе текста.");
  }
});

// Обработка пересланного поста
async function processPost(chatId, msg) {
  const postData = {
    text: cleanText(msg.caption || ""),
    image: [],
    links: [],
  };

  // Поиск изображений
  const photoResult = await searchPhoto(msg);
  if (photoResult) {
    postData.image.push(photoResult);
  }

  // Поиск ссылок
  const linksResult = await searchLinks(msg);
  if (linksResult) postData.links.push(...linksResult);

  chatData[chatId].posts.push(postData);
  await bot.sendMessage(chatId, "Пост добавлен в обработку");
}

// Обработка одиночного сообщения
async function processSingleMessage(chatId, msg) {
  const formattedText = cleanText(msg.text || msg.caption || "");
  let photoPath = "";

  const cozeResponse = await sendTextToCoze(formattedText);

  await bot.sendMessage(chatId, cozeResponse);

  // Поиск изображений
  if (msg.photo) {
    photoPath = await bot.downloadFile(
      msg.photo[msg.photo.length - 1].file_id,
      "./images"
    );
  }

  // Поиск ссылок
  const linksResult = await searchLinks(msg);
  if (linksResult && linksResult.length > 0) {
    const linksText = linksResult
      .map(
        (link) => `Фрагмент текста: ${link.context}\n\t  |→ Ссылка: ${link.url}`
      )
      .join("\n");
    await bot.sendMessage(chatId, `🔗 Ссылки из поста:\n${linksText}`, {
      disable_web_page_preview: true,
    });
  } else {
    await bot.sendMessage(chatId, "Не удалось найти ссылки.");
  }

  //Отправка изображения
  if (photoPath) {
    await bot.sendPhoto(chatId, photoPath);
  } else {
    await bot.sendMessage(chatId, "Не удалось найти изображения.");
  }

  // Удаляем временные файлы
  fs.unlink(photoPath, (error) => {
    if (error) console.error("Ошибка при удалении файла:", error);
  });
}

// Обработка завершения сбора постов
async function finishCollection(chatId) {
  chatData[chatId].isCollecting = false;

  if (chatData[chatId].posts.length === 0) {
    await bot.sendMessage(chatId, "Не было собрано ни одного поста", {
      reply_markup: {
        remove_keyboard: true,
      },
    });
    return;
  }

  await bot.sendMessage(chatId, "Обрабатываю...", {
    reply_markup: {
      remove_keyboard: true,
    },
  });

  let postsTextData = "";
  let linksData = "";
  let photoPath = [];

  // Собираем тексты и ссылки
  for (let i = 0; i < chatData[chatId].posts.length; i++) {
    const post = chatData[chatId].posts[i];
    postsTextData += `Текст #${i + 1}: \n${post.text}\n`;

    if (post.links.length > 0) {
      linksData += `🔗 Ссылки из поста #${i + 1}:\n`;
      post.links.forEach((link) => {
        linksData += `Фрагмент текста: ${link.context}\n\t  |→ Ссылка: ${link.url}\n`;
      });
    } else {
      linksData += `🔗 В посте #${i + 1} ссылок не найдено\n`;
    }

    photoPath.push(...post.image);
  }

  const cozeResponse = await sendTextToCoze(postsTextData);

  await bot.sendMessage(chatId, cozeResponse);

  await bot.sendMessage(chatId, linksData, { disable_web_page_preview: true });

  // Отправляем группу изображений
  await sendGroupImage(chatId, photoPath);

  // Очищаем данные
  chatData[chatId].posts = [];
}
