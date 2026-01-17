const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();
const express = require("express");

// =====================
// CONFIGURATION
// =====================
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { webHook: true });
const app = express();
app.use(express.json());

// =====================
// DATA STRUCTURES
// =====================
const waitingQueue = new Set();
const activeChats = new Map();
const reportedUsers = new Map(); // userId => number of reports
const blockedUsers = new Map(); // userId => timestamp when block expires (0 = permanent)
const chatHistory = new Map(); // userId => array of messageIds


// =====================
// HELPERS
// =====================
function addMessageToHistory(userId, messageId) {
  if (!chatHistory.has(userId)) chatHistory.set(userId, []);
  chatHistory.get(userId).push(messageId);
}

async function clearChatHistory(userId) {
  if (!chatHistory.has(userId)) return;
  const ids = chatHistory.get(userId);
  for (const msgId of ids) {
    try {
      await bot.deleteMessage(userId, msgId);
    } catch (e) {}
  }
  chatHistory.set(userId, []);
}

function isBlocked(userId) {
  if (!blockedUsers.has(userId)) return false;
  const unblockTime = blockedUsers.get(userId);
  if (unblockTime === 0) return true; // permanent
  if (Date.now() > unblockTime) {
    blockedUsers.delete(userId);
    return false;
  }
  return true;
}

// =====================
// MESSAGE RELAY HELPERS
// =====================
async function sendMessageWithHistory(userId, text, options = {}) {
  const msg = await bot.sendMessage(userId, text, options);
  addMessageToHistory(userId, msg.message_id);
  return msg;
}

async function sendDocumentWithHistory(userId, fileId, options = {}) {
  const msg = await bot.sendDocument(userId, fileId, options);
  addMessageToHistory(userId, msg.message_id);
  return msg;
}

async function sendPhotoWithHistory(userId, fileId, options = {}) {
  const msg = await bot.sendPhoto(userId, fileId, options);
  addMessageToHistory(userId, msg.message_id);
  return msg;
}

async function sendAudioWithHistory(userId, fileId, options = {}) {
  const msg = await bot.sendAudio(userId, fileId, options);
  addMessageToHistory(userId, msg.message_id);
  return msg;
}

async function sendVideoWithHistory(userId, fileId, options = {}) {
  const msg = await bot.sendVideo(userId, fileId, options);
  addMessageToHistory(userId, msg.message_id);
  return msg;
}

async function sendVoiceWithHistory(userId, fileId, options = {}) {
  const msg = await bot.sendVoice(userId, fileId, options);
  addMessageToHistory(userId, msg.message_id);
  return msg;
}

// =====================
// END CHAT
// =====================
function stopChat(userId, showOptions = true) {
  const partnerId = activeChats.get(userId);
  if (!partnerId) return;

  activeChats.delete(userId);
  activeChats.delete(partnerId);

  const buttons = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Find another", callback_data: "find_again" },
          { text: "Report", callback_data: "report_partner" },
        ],
      ],
    },
  };

  if (showOptions) bot.sendMessage(userId, "🛑 You left the chat.", buttons);
  else bot.sendMessage(userId, "🛑 You left the chat.");

  bot.sendMessage(partnerId, "⚠️ Your partner left the chat.", buttons);
}

// =====================
// FIND MATCH
// =====================
async function findMatch(userId, clearHistory = false) {
  if (isBlocked(userId)) {
    return bot.sendMessage(
      userId,
      "⚠️ You are currently blocked and cannot join chats.",
    );
  }

  if (activeChats.has(userId)) {
    return sendMessageWithHistory(
      userId,
      "⚠️ You are already in a chat. Stop current chat first.",
    );
  }

  if (clearHistory) {
    await clearChatHistory(userId);
    waitingQueue.delete(userId);
  }

  for (let potentialPartner of waitingQueue) {
    if (potentialPartner !== userId && !isBlocked(potentialPartner)) {
      waitingQueue.delete(potentialPartner);
      if (clearHistory) await clearChatHistory(potentialPartner);

      activeChats.set(userId, potentialPartner);
      activeChats.set(potentialPartner, userId);

      await sendMessageWithHistory(
        userId,
        "🎉 You are now chatting anonymously!",
      );
      await sendMessageWithHistory(
        potentialPartner,
        "🎉 You are now chatting anonymously!",
      );
      return;
    }
  }

  waitingQueue.add(userId);
  await sendMessageWithHistory(
    userId,
    clearHistory
      ? "⏳ Waiting for a new partner..."
      : "⏳ Waiting for someone to chat with...",
  );
}

// =====================
// REPORT PARTNER
// =====================
function reportPartner(userId) {
  const partnerId = activeChats.get(userId);
  if (!partnerId)
    return bot.sendMessage(userId, "⚠️ No active chat to report.");

  const count = reportedUsers.get(partnerId) || 0;
  const newCount = count + 1;
  reportedUsers.set(partnerId, newCount);

  bot.sendMessage(userId, `✅ Partner reported. You left the chat.`);
  stopChat(userId);

  let blockDuration = 0;
  if (newCount >= 30)
    blockDuration = 0; // indefinite
  else if (newCount >= 20)
    blockDuration = 24 * 60 * 60 * 1000; // 1 day
  else if (newCount >= 10)
    blockDuration = 30 * 60 * 1000; // 30 min
  else if (newCount >= 3) blockDuration = 5 * 60 * 1000; // 5 min

  if (blockDuration !== 0 || newCount >= 30) {
    blockedUsers.set(
      partnerId,
      blockDuration === 0 ? 0 : Date.now() + blockDuration,
    );
    const timeText =
      blockDuration === 0
        ? "indefinitely"
        : `${Math.floor(blockDuration / 60000)} minutes`;
    bot.sendMessage(
      partnerId,
      `⚠️ You have been blocked for ${timeText} due to multiple reports.`,
    );
  }
}

// =====================
// BOT COMMANDS
// =====================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const welcomeMessage =
    "👻 Welcome to GhostChats!\n\n" +
    "Commands:\n" +
    "/find - Find a random chat partner\n" +
    "/stop - End current chat\n" +
    "/report - Report abusive partner\n" +
    "/help - Show commands list\n" +
    "/premium - View premium features\n\n" +
    "For more features and a modern chat experience, try our Web App:";

  const buttons = {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "💬 Open Web Chat",
            web_app: {
              url: "https://boredmonkeychats.web.app/",
            },
          },
        ],
      ],
    },
  };

  bot.sendMessage(chatId, welcomeMessage, buttons);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "📜 Commands list:\n" +
      "/find - Find a chat\n" +
      "/stop - Stop chat\n" +
      "/report - Report partner\n" +
      "/premium - Premium features",
  );
});

bot.onText(/\/webchat/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(chatId, "💬 Open GhostChat Web App:", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Open Web Chat",
            web_app: {
              url: "https://boredmonkeychats.web.app/", // Telegram web app link
            },
          },
        ],
      ],
    },
  });
});

bot.onText(/\/find/, (msg) => findMatch(msg.from.id));
bot.onText(/\/stop/, (msg) => stopChat(msg.from.id));
bot.onText(/\/report/, (msg) => reportPartner(msg.from.id));
bot.onText(/\/premium/, (msg) =>
  bot.sendMessage(msg.chat.id, "💎 Premium coming soon!"),
);

// =====================
// INLINE BUTTON HANDLER
// =====================
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const data = query.data;

  if (data === "stop_chat") stopChat(userId);
  if (data === "report_partner") reportPartner(userId);
  if (data === "find_again") await findMatch(userId, true);

  bot.answerCallbackQuery(query.id);
});

// =====================
// MESSAGE RELAY
// =====================
bot.on("message", async (msg) => {
  if (!msg.from || msg.from.is_bot) return;

  const userId = msg.from.id;

  if (!(msg.text && msg.text.startsWith("/")))
    addMessageToHistory(userId, msg.message_id);
  if (msg.text && msg.text.startsWith("/")) return;

  const partnerId = activeChats.get(userId);
  if (!partnerId) return;

  if (msg.text) await sendMessageWithHistory(partnerId, msg.text);
  else if (msg.document)
    await sendDocumentWithHistory(partnerId, msg.document.file_id);
  else if (msg.photo) {
    const largestPhoto = msg.photo[msg.photo.length - 1];
    await sendPhotoWithHistory(partnerId, largestPhoto.file_id);
  } else if (msg.audio)
    await sendAudioWithHistory(partnerId, msg.audio.file_id);
  else if (msg.video) await sendVideoWithHistory(partnerId, msg.video.file_id);
  else if (msg.voice) await sendVoiceWithHistory(partnerId, msg.voice.file_id);
});

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

app.get("/", (req, res) => res.send("GhostChats bot is running 👻"));

app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

async function startBot() {
  try {
    // Start Express server first
    app.listen(PORT, () => {
      console.log(`🚀 Express server running on port ${PORT}`);
    });

    // Set Telegram webhook
    const webhookUrl = `${WEBHOOK_URL}/webhook`;
    await bot.setWebHook(webhookUrl);
    console.log("👻 GhostChats webhook running at:", webhookUrl);
  } catch (err) {
    console.error("Failed to start bot:", err);
  }
}

startBot();

