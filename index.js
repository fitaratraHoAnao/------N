const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const login = require("josh-fca");
const fs = require("fs");
const autoReact = require("./handle/autoReact");
const unsendReact = require("./handle/unsendReact");
const chalk = require("chalk");

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
  JOSHUA: "https://nash-api-vrx5.onrender.com/"
};

let isLoggedIn = false;
let loginAttempts = 0;
const MAX_RETRIES = 5;
const RETRY_INTERVAL = 5000;

const loadModules = (type) => {
  const folderPath = path.join(__dirname, type);
  const files = fs.readdirSync(folderPath).filter(file => file.endsWith(".js"));

  console.log(chalk.bold.redBright(`──LOADING ${type.toUpperCase()}──●`));
  
  files.forEach(file => {
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

const AutoLogin = async () => {
  if (isLoggedIn) return;

  const appStatePath = path.join(__dirname, "appstate.json");
  if (fs.existsSync(appStatePath)) {
    const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
    login({ appState }, (err, api) => {
      if (err) {
        console.error(
          chalk.bold.gray("[") + 
          chalk.bold.red("ERROR") + 
          chalk.bold.gray("] ") + 
          chalk.bold.redBright("Failed to auto-login:")
        );
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
    console.error(
      chalk.bold.gray("[") + 
      chalk.bold.red("ERROR") + 
      chalk.bold.gray("] ") + 
      chalk.bold.redBright("Max login attempts reached. Please check your appstate file.")
    );
    return;
  }

  loginAttempts++;
  console.log(
    chalk.bold.gray("[") + 
    chalk.bold.yellow("RETRY") + 
    chalk.bold.gray("] ") + 
    chalk.bold.yellowBright(`Retrying login attempt ${loginAttempts} of ${MAX_RETRIES}...`)
  );

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
      console.error(
        chalk.bold.gray("[") + 
        chalk.bold.red("ERROR") + 
        chalk.bold.gray("] ") + 
        chalk.bold.redBright("Connection error detected, attempting relogin...")
      );
      isLoggedIn = false;
      retryLogin();
      return;
    }

    handleMessage(api, event, prefix);
    handleEvent(api, event, prefix);
    autoReact(api, event);
    unsendReact(api, event);
  });

  setInterval(() => {
    api.getFriendsList(() => console.log(
      chalk.bold.gray("[") + 
      chalk.bold.cyan("INFO") + 
      chalk.bold.gray("] ") + 
      chalk.bold.green("Keep-alive signal sent")
    ));
  }, 1000 * 60 * 15);
};

const handleEvent = async (api, event, prefix) => {
  const { events } = global.NashBoT;
  try {
    for (const { onEvent } of events.values()) {
      await onEvent({ prefix, api, event });
    }
  } catch (err) {
    console.error(
      chalk.bold.gray("[") + 
      chalk.bold.red("ERROR") + 
      chalk.bold.gray("] ") + 
      chalk.bold.redBright("Event handler error:")
    );
  }
};

const handleMessage = async (api, event, prefix) => {
  if (!event.body) return;

  let [command, ...args] = event.body.trim().split(" ");
  if (command.startsWith(prefix)) command = command.slice(prefix.length);

  const cmdFile = global.NashBoT.commands.get(command.toLowerCase());
  if (cmdFile) {
    const nashPrefix = cmdFile.nashPrefix !== false;
    if (nashPrefix && !event.body.toLowerCase().startsWith(prefix)) return;

    const userId = event.senderID;
    if (cmdFile.role === "admin" && userId !== config.adminUID) {
      return api.sendMessage("You don't have permission to use this commands", event.threadID);
    }

    try {
      await cmdFile.execute(api, event, args, prefix);
    } catch (err) {
      api.sendMessage(`Command error: ${err.message}`, event.threadID);
    }
  }
};

const init = async () => {
  await loadModules("commands");
  await loadModules("events");
  await AutoLogin();
  console.log(chalk.bold.blueBright("──BOT START──●"));
  console.log(chalk.bold.red(`
█▄░█ ▄▀█ █▀ █░█
█░▀█ █▀█ ▄█ █▀█`));
  console.log(chalk.bold.yellow("Credits: Joshua Apostol"));
};

init().then(() => app.listen(PORT, () => console.log(
  chalk.bold.gray("[") + 
  chalk.bold.green("SERVER") + 
  chalk.bold.gray("] ") + 
  chalk.bold.greenBright(`Running on http://localhost:${PORT}`)
)));

