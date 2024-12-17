const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const login = require("josh-fca");
const fs = require("fs");
const autoReact = require("./handle/autoReact");
const unsendReact = require("./handle/unsendReact");
const chalk = require("chalk");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

app.use(bodyParser.json());
app.use(express.static("public"));

global.NashBoT = {
  commands: new Map(),
  events: new Map(),
  onlineUsers: new Map(),
};

global.NashBot = {
  JOSHUA: "https://nash-api-vrx5.onrender.com/",
};

let isLoggedIn = false;
let loginAttempts = 0;
const MAX_RETRIES = 5;
const RETRY_INTERVAL = 5000;

const MAX_MESSAGE_LENGTH = 2000; // Limite pour la réponse en morceaux

const loadModules = (type) => {
  const folderPath = path.join(__dirname, type);
  const files = fs.readdirSync(folderPath).filter((file) => file.endsWith(".js"));

  console.log(chalk.bold.redBright(`──LOADING ${type.toUpperCase()}──●`));

  files.forEach((file) => {
    const module = require(path.join(folderPath, file));
    if (module && module.name && module[type === "commands" ? "execute" : "onEvent"]) {
      module.nashPrefix = module.nashPrefix !== undefined ? module.nashPrefix : true;
      global.NashBoT[type].set(module.name, module);
      console.log(
        chalk.bold.gray("[") +
          chalk.bold.cyan("INFO") +
          chalk.bold.gray("] ") +
          chalk.bold.green(`Loaded ${type.slice(0, -1)}: `) +
          chalk.bold.magenta(module.name)
      );
    }
  });
};

const sendLongMessage = async (api, threadID, message) => {
  for (let i = 0; i < message.length; i += MAX_MESSAGE_LENGTH) {
    const messagePart = message.substring(i, i + MAX_MESSAGE_LENGTH);
    await api.sendMessage(messagePart, threadID);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const AutoLogin = async () => {
  if (isLoggedIn) return;

  const appStatePath = path.join(__dirname, "appstate.json");
  if (fs.existsSync(appStatePath)) {
    const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
    login({ appState }, (err, api) => {
      if (err) {
        console.error(chalk.bold.red("Failed to auto-login"));
        retryLogin();
        return;
      }
      const cuid = api.getCurrentUserID();
      global.NashBoT.onlineUsers.set(cuid, { userID: cuid, prefix: config.prefix });
      setupBot(api, config.prefix);
      isLoggedIn = true;
      loginAttempts = 0;
    });
  }
};

const retryLogin = () => {
  if (loginAttempts >= MAX_RETRIES) {
    console.error(chalk.bold.red("Max login attempts reached."));
    return;
  }
  loginAttempts++;
  console.log(chalk.bold.yellow(`Retrying login attempt ${loginAttempts}...`));
  setTimeout(AutoLogin, RETRY_INTERVAL);
};

const setupBot = (api, prefix) => {
  api.setOptions({
    forceLogin: false,
    selfListen: true,
    autoReconnect: true,
    listenEvents: true,
  });

  api.listenMqtt((err, event) => {
    if (err) {
      console.error(chalk.bold.red("Connection error detected, attempting relogin..."));
      isLoggedIn = false;
      retryLogin();
      return;
    }
    handleMessage(api, event, prefix);
    handleEvent(api, event, prefix);
    autoReact(api, event);
    unsendReact(api, event);
  });
};

const handleMessage = async (api, event, prefix) => {
  if (!event.body && !event.attachments) return;

  const { threadID, senderID, body, attachments } = event;

  let [command, ...args] = (body || "").trim().split(" ");
  if (command.startsWith(prefix)) command = command.slice(prefix.length);

  const cmdFile = global.NashBoT.commands.get(command.toLowerCase());
  
  // Logique pour commandes avec préfixe
  if (cmdFile) {
    try {
      await cmdFile.execute(api, event, args, prefix);
      return;
    } catch (err) {
      api.sendMessage(`Command error: ${err.message}`, threadID);
      return;
    }
  }

  // Logique pour les messages avec image (Gemini)
  if (attachments && attachments.length > 0) {
    const image = attachments.find((att) => att.type === "photo");
    if (image) {
      const imageUrl = image.url;
      try {
        const response = await axios.post("https://gemini-sary-prompt-espa-vercel-api.vercel.app/api/gemini", {
          link: imageUrl,
          prompt: "Décrire cette photo en détail",
          customId: senderID,
        });
        const reply = response.data.message;
        await sendLongMessage(api, threadID, reply);
      } catch (err) {
        console.error("Erreur avec l'API Gemini :", err.message);
        api.sendMessage("Une erreur s'est produite lors de l'analyse de l'image.", threadID);
      }
      return;
    }
  }

  // Logique par défaut pour Gemini si aucun préfixe/commande détecté
  if (body) {
    try {
      const response = await axios.post("https://gemini-sary-prompt-espa-vercel-api.vercel.app/api/gemini", {
        prompt: body,
        customId: senderID,
      });
      const reply = response.data.message;
      await sendLongMessage(api, threadID, reply);
    } catch (err) {
      console.error("Erreur avec l'API Gemini :", err.message);
      api.sendMessage("Désolé, une erreur s'est produite lors du traitement de votre message.", threadID);
    }
  }
};

const handleEvent = async (api, event, prefix) => {
  const { events } = global.NashBoT;
  try {
    for (const { onEvent } of events.values()) {
      await onEvent({ prefix, api, event });
    }
  } catch (err) {
    console.error(chalk.bold.red("Event handler error"));
  }
};

const init = async () => {
  await loadModules("commands");
  await loadModules("events");
  await AutoLogin();
  console.log(chalk.bold.blueBright("──BOT START──●"));
};

init().then(() => app.listen(PORT, () => console.log(chalk.bold.green(`Running on http://localhost:${PORT}`))));
