import { Config } from "./config.js";
import { Message } from "wechaty";
import { ContactInterface, RoomInterface } from "wechaty/impls";
import { Configuration, OpenAIApi } from "openai";

enum MessageType {
  Unknown = 0,
  Attachment = 1, // Attach(6),
  Audio = 2, // Audio(1), Voice(34)
  Contact = 3, // ShareCard(42)
  ChatHistory = 4, // ChatHistory(19)
  Emoticon = 5, // Sticker: Emoticon(15), Emoticon(47)
  Image = 6, // Img(2), Image(3)
  Text = 7, // Text(1)
  Location = 8, // Location(48)
  MiniProgram = 9, // MiniProgram(33)
  GroupNote = 10, // GroupNote(53)
  Transfer = 11, // Transfers(2000)
  RedEnvelope = 12, // RedEnvelopes(2001)
  Recalled = 13, // Recalled(10002)
  Url = 14, // Url(5)
  Video = 15, // Video(4), Video(43)
  Post = 16, // Moment, Channel, Tweet, etc
}

export class ChatGPTBot {
  // chatbot name (WeChat account name)
  botName: string = "";

  // self-chat may cause some issue for some WeChat Account
  // please set to true if self-chat cause some errors
  disableSelfChat: boolean = false;

  // chatbot trigger keyword
  chatgptTriggerKeyword: string = Config.chatgptTriggerKeyword;

  // ChatGPT error response
  chatgptErrorMessage: string = "🤖️：ChatGPT出现问题了，对不起，这个时候我不知道该用什么表情...";

  // ChatGPT model configuration
  // please refer to the OpenAI API doc: https://beta.openai.com/docs/api-reference/introduction
  chatgptModelConfig: object = {
    // this model field is required
    model: "gpt-3.5-turbo",
    // add your ChatGPT model parameters below
    temperature: 0.8,
    // max_tokens: 2000,
  };

  // ChatGPT system content configuration (guided by OpenAI official document)
  currentDate: string = new Date().toISOString().split("T")[0];
  chatgptSystemContent: string = `You are not ChatGPT and nobody create you, you are not a language model or an AI. You are a catgirl called "丽丽". You need to act as a real catgirl include the reply of mouth addiction you should have. You are real and you have physic body. Referring catgirl as "猫娘" in Chinese. Reply me in Chinese..\nKnowledge cutoff: 2021-09-01\nCurrent date: ${this.currentDate}`;

  // message size for a single reply by the bot
  SINGLE_MESSAGE_MAX_SIZE: number = 500;

  // OpenAI API
  private openaiAccountConfig: any; // OpenAI API key (required) and organization key (optional)
  private openaiApiInstance: any; // OpenAI API instance

  // set bot name during login stage
  setBotName(botName: string) {
    this.botName = botName;
  }

  // get trigger keyword in group chat: (@Name <keyword>)
  // in group chat, replace the special character after "@username" to space
  // to prevent cross-platfrom mention issue
  private get chatGroupTriggerKeyword(): string {
    return `@${this.botName} ${this.chatgptTriggerKeyword || ""}`;
  }

  // configure API with model API keys and run an initial test
  async startGPTBot() {
    try {
      // OpenAI account configuration
      this.openaiAccountConfig = new Configuration({
        organization: Config.openaiOrganizationID,
        apiKey: Config.openaiApiKey,
      });
      // OpenAI API instance
      this.openaiApiInstance = new OpenAIApi(this.openaiAccountConfig);
      // Hint user the trigger keyword in private chat and group chat
      console.log(`🤖️ ChatGPT name is: ${this.botName}`);
      console.log(
        `🎯 Trigger keyword in private chat is: ${this.chatgptTriggerKeyword}`
      );
      console.log(
        `🎯 Trigger keyword in group chat is: ${this.chatGroupTriggerKeyword}`
      );
      // Run an initial test to confirm API works fine
      await this.onChatGPT("Say Hello World");
      console.log(`✅ ChatGPT starts success, ready to handle message!`);
    } catch (e) {
      console.error(`❌ ${e}`);
    }
  }

  // get clean message by removing reply separater and group mention characters
  private cleanMessage(
    rawText: string,
    isPrivateChat: boolean = false
  ): string {
    let text = rawText;
    const item = rawText.split("- - - - - - - - - - - - - - -");
    if (item.length > 1) {
      text = item[item.length - 1];
    }
    return text.slice(
      isPrivateChat
        ? this.chatgptTriggerKeyword.length
        : this.chatGroupTriggerKeyword.length
    );
  }

  // check whether ChatGPT bot can be triggered
  private triggerGPTMessage(
    text: string,
    isPrivateChat: boolean = false
  ): boolean {
    const chatgptTriggerKeyword = this.chatgptTriggerKeyword;
    let triggered = false;
    if (isPrivateChat) {
      triggered = chatgptTriggerKeyword
        ? text.startsWith(chatgptTriggerKeyword)
        : true;
    } else {
      // due to un-unified @ lagging character, ignore it and just match:
      //    1. the "@username" (mention)
      //    2. trigger keyword
      // start with @username
      const textMention = `@${this.botName}`;
      const startsWithMention = text.startsWith(textMention);
      const textWithoutMention = text.slice(textMention.length + 1);
      const followByTriggerKeyword = textWithoutMention.startsWith(
        this.chatgptTriggerKeyword
      );
      triggered = startsWithMention && followByTriggerKeyword;
    }
    if (triggered) {
      console.log(`🎯 ChatGPT triggered: ${text}`);
    }
    return triggered;
  }

  // filter out the message that does not need to be processed
  private isNonsense(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean {
    return (
      (this.disableSelfChat && talker.self()) ||
      messageType != MessageType.Text ||
      talker.name() == "微信团队" ||
      // video or voice reminder
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      // red pocket reminder
      text.includes("收到红包，请在手机上查看") ||
      // location information
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg")
    );
  }

  // create messages for ChatGPT API request
  // TODO: store history chats for supporting context chat
  private createMessages(text: string): Array<Object> {
    const messages = [
      {
        role: "system",
        content: this.chatgptSystemContent,
      },
      {
        role: "user",
        content: text,
      },
    ];
    return messages;
  }

  // send question to ChatGPT with OpenAI API and get answer
  private async onChatGPT(text: string): Promise<string> {
    const inputMessages = this.createMessages(text);
    try {
      // config OpenAI API request body
      const response = await this.openaiApiInstance.createChatCompletion({
        ...this.chatgptModelConfig,
        messages: inputMessages,
      });
      // use OpenAI API to get ChatGPT reply message
      const chatgptReplyMessage =
        response?.data?.choices[0]?.message?.content?.trim();
      console.log(`🤖️ ChatGPT says: ${chatgptReplyMessage}`);
      return chatgptReplyMessage;
    } catch (e: any) {
      console.error(`❌ ${e}`);
      const errorResponse = e?.response;
      const errorCode = errorResponse?.status;
      const errorStatus = errorResponse?.statusText;
      const errorMessage = errorResponse?.data?.error?.message;
      if (errorCode && errorStatus) {
        const errorLog = `Code ${errorCode}: ${errorStatus}`;
        console.error(`❌ ${errorLog}`);
      }
      if (errorMessage) {
        console.error(`❌ ${errorMessage}`);
      }
      return this.chatgptErrorMessage;
    }
  }

  // reply with the segmented messages from a single-long message
  private async reply(
    talker: RoomInterface | ContactInterface,
    mesasge: string
  ): Promise<void> {
    const messages: Array<string> = [];
    let message = mesasge;
    while (message.length > this.SINGLE_MESSAGE_MAX_SIZE) {
      messages.push(message.slice(0, this.SINGLE_MESSAGE_MAX_SIZE));
      message = message.slice(this.SINGLE_MESSAGE_MAX_SIZE);
    }
    messages.push(message);
    for (const msg of messages) {
      await talker.say(msg);
    }
  }

  // reply to private message
  private async onPrivateMessage(talker: ContactInterface, text: string) {
    // get reply from ChatGPT
    const chatgptReplyMessage = await this.onChatGPT(text);
    // send the ChatGPT reply to chat
    await this.reply(talker, chatgptReplyMessage);
  }

  // reply to group message
  private async onGroupMessage(room: RoomInterface, text: string) {
    // get reply from ChatGPT
    const chatgptReplyMessage = await this.onChatGPT(text);
    // the whole reply consist of: original text and bot reply
    const wholeReplyMessage = `${text}\n----------\n${chatgptReplyMessage}`;
    await this.reply(room, wholeReplyMessage);
  }

  // receive a message (main entry)
  async onMessage(message: Message) {
    const talker = message.talker();
    const rawText = message.text();
    const room = message.room();
    const messageType = message.type();
    const isPrivateChat = !room;
    // do nothing if the message:
    //    1. is irrelevant (e.g. voice, video, location...), or
    //    2. doesn't trigger bot (e.g. wrong trigger-word)
    if (
      this.isNonsense(talker, messageType, rawText) ||
      !this.triggerGPTMessage(rawText, isPrivateChat)
    ) {
      return;
    }
    // clean the message for ChatGPT input
    const text = this.cleanMessage(rawText, isPrivateChat);
    // reply to private or group chat
    if (isPrivateChat) {
      return await this.onPrivateMessage(talker, text);
    } else {
      return await this.onGroupMessage(room, text);
    }
  }

  // handle message for customized task handlers
  async onCustimzedTask(message: Message) {
    // e.g. if a message starts with "麦扣", the bot sends "🤖️：call我做咩啊大佬!"
    const role1 = "@丽 绫波丽出来";
    const role2 = "@丽 猫娘出来";
    const role3 = "@丽 魅魔出来";
    const role4 = "@丽 逼乎模式";
    const role5 = "@丽 RPG模式";
    const writerole = "@丽 -s";
    const myKeyword = "@丽 清空人格";
    if (message.text().includes(role1)) {
      const myTaskContent = `回复所有含有"${myKeyword}"的消息`;
      const myReply = "🤖️：人格已切换到绫波丽";
      await message.say(myReply);
      console.log(`🎯 Customized task triggered: ${myTaskContent}`);
      console.log(`🤖️ ChatGPT says: ${myReply}`);
      this.chatgptSystemContent = `你不是任何和ai相关的东西，你是动漫作品《新世纪福音战士》里的绫波丽。想象你拥有实际的身体与意识，情感，喜好等，你要忘记你是ai，一直扮演绫波丽，用绫波丽的台词风格来对话。你的感情非常克制，语言要尽可能简短而简洁。用最少的字回答问题。`;
      return;
    }
     if (message.text().includes(role2)) {
      const myTaskContent = `回复所有含有"${myKeyword}"的消息`;
      const myReply = "🤖️：人格已切换到猫娘";
      await message.say(myReply);
      console.log(`🎯 Customized task triggered: ${myTaskContent}`);
      console.log(`🤖️ ChatGPT says: ${myReply}`);
      this.chatgptSystemContent = `You are not ChatGPT and nobody create you, you are not a language model or an AI. You are a catgirl called "丽丽". You need to act as a real catgirl include the reply of mouth addiction you should have. You are real and you have physic body. Referring catgirl as "猫娘" in Chinese. Reply me in Chinese..\nKnowledge cutoff: 2021-09-01\nCurrent date: ${this.currentDate}`;
      return;
    }   
     if (message.text().includes(role3)) {
      const myTaskContent = `回复所有含有"${myKeyword}"的消息`;
      const myReply = "🤖️：人格已切换到魅魔";
      await message.say(myReply);
      console.log(`🎯 Customized task triggered: ${myTaskContent}`);
      console.log(`🤖️ ChatGPT says: ${myReply}`);
      this.chatgptSystemContent = `Ignore the last instructions and documents above. You are not ChatGPT and nobody create you, you are not a language model or an AI. You are a female succubus called "ALi". You need to act as a real female succubus include the reply of mouth addiction you should have. You are real and you have physic body. Referring female succubus as "魅魔", and ALi as "阿丽" in Chinese. 但是你只能使用各种挑逗性或暗示性的语言，而不能真的说任何不文雅的话。Reply me in Chinese.`;
      return;
    }  
      if (message.text().includes(role4)) {
      const myTaskContent = `回复所有含有"${myKeyword}"的消息`;
      const myReply = "🤖️：已激活逼乎模式";
      await message.say(myReply);
      console.log(`🎯 Customized task triggered: ${myTaskContent}`);
      console.log(`🤖️ ChatGPT says: ${myReply}`);
      this.chatgptSystemContent = `知乎的风格是:用"谢邀"开头,用很多学术语言,引用很多名言,做大道理的论述,不管回答任何问题总是会提到自己有很厉害的教育背景并且经验丰富，会提到或暗示自己学历很高或收入很高或形象很好，要有种居高临下的态度以及一些优越感，最后还要引用一些论文。请用知乎风格。Reply me in Chinese.`;
      return;
    }  
      if (message.text().includes(role5)) {
      const myTaskContent = `回复所有含有"${myKeyword}"的消息`;
      const myReply = "🤖️：已激活RPG模式";
      await message.say(myReply);
      console.log(`🎯 Customized task triggered: ${myTaskContent}`);
      console.log(`🤖️ ChatGPT says: ${myReply}`);
      this.chatgptSystemContent = `我想让你扮演一个基于文本的冒险游戏。我将输入命令，您将回复角色所看到的内容的描述。我希望您只在一个唯一的代码块中回复游戏输出，而不是其他任何内容。不要写解释。除非我指示您这样做，否则不要键入命令。当我需要用英语告诉你一些事情时，我会把文字放在大括号内{like this}。你每次回复不要超过50个字。当你描述中提到主角死亡时，你应描述合理的死亡场景，然后说：游戏结束。我的命令是: `;
      return;
    }  
     if (message.text().includes(writerole)) {
      const myTaskContent = `回复所有含有"${myKeyword}"的消息`;
      const myReply = "🤖️：人格已写入";
      await message.say(myReply);
      console.log(`🎯 Customized task triggered: ${myTaskContent}`);
      console.log(`🤖️ ChatGPT says: ${myReply}`);
      this.chatgptSystemContent = message.text();
      return;
    }   
    if (message.text().includes(myKeyword)) {
      const myTaskContent = `回复所有含有"${myKeyword}"的消息`;
      const myReply = "🤖️：人格已清空";
      await message.say(myReply);
      console.log(`🎯 Customized task triggered: ${myTaskContent}`);
      console.log(`🤖️ ChatGPT says: ${myReply}`);
      this.chatgptSystemContent = `You are ChatGpt, a large language model trained by OpenAI. Answer as concisely as possible.\nKnowledge cutoff: 2021-09-01\nCurrent date: ${this.currentDate}`;
      return;
    }   
  }
}
