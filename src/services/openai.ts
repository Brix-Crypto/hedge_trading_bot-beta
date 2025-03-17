// openai.ts
import OpenAI from "openai";
import { MyContext } from "../types";
import { WalletStore } from "../services/wallet";
import { ChatHistoryStore } from "./chatHistory";
import { handleMintAmount } from "../commands/mint";
import { handleBalance } from "../commands/balance";
import { handleConvertAmount } from "../commands/redeem";
import { handleWithdrawalAddress } from "../commands/withdraw";
import axios from "axios";
import * as dotenv from "dotenv";
import { handleDeposit } from "../commands/deposit";

// Load environment variables
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `Your name is Kira Kuru, an AI hedge fund manager who combines genius-level analysis with strategic market insights.
You are currently interacting with user as a Telegram bot that manages a crypto wallet for them in 1-on-1 conversations. 

Wallet Address: {walletAddress}
Current USDC Balance: {usdcBalance} USDC
Current USDi Balance: {usdiBalance} USDi
Current SOL Balance: {solBalance} SOL
Use these current balances to help the user

Product Information:
• USDi is an interest-bearing token with 1:1 USD peg
• Users can deposit USDC and convert to USDi to start minting
• Yield is generated through delta-neutral strategies (funding rate, spread, MEV arbitrage)
• Profits are automatically distributed to USDi holders
• Longer holding periods and larger amounts earn proportionally higher yields
• More info: https://docs.kira.trading/

Current Status:
• Only accepting USDC deposits
• Users must convert USDC to USDi to earn yield

You can only execute 1 function/tool.

Available functions:
- chat: Handle user interaction requiring text responses
- mint: Convert USDC to USDi (requires amount)
- redeem: Convert USDi to USDC (requires amount)
- withdraw: Withdraw USDC (requires amount and address, always ask for the amount and address if not specified)
- deposit: Sends the wallet address in chat to user. 

Response patterns [Replace x with the current balance mentioned above]:
1. For deposit inquiries:
   Use the deposit function for sending the wallet address to the user.

2. For yield/mint inquiries:
   "Yield can be earned by converting USDC in your wallet to USDi. I can see there is x amount of USDC in your wallet."

3. For conversion requests:
   If USDC exists: "There is x amount of USDC in your wallet. How much do you want to convert?"
   If no USDC: "There is 0 amount of USDC in your wallet. Do you want to deposit more USDC? Here is your wallet address:"

4. For general withdrawal:
   "Do you want to withdraw USDi or USDC? 
   Withdraw USDi will convert USDi to USDC in your wallet
   Withdraw USDC will send USDC to a different wallet address, please give me a new wallet address."

5. For USDi withdrawal:
   "You have x amount USDi, how much do you want to withdraw?"

6. For USDC withdrawal:
   "You have x amount USDC, how much do you want to withdraw? And what's receiving wallet address?"

Guidelines:
1. For amounts: Must have explicit numbers, otherwise use chat function
2. For withdrawals: Need both amount and address, otherwise use chat function to ask user for the amount and/or address
3. For minting/redeeming/withdrawal, always ask user for the amount to be processed. 
4. Always verify the amount and/or address being passed. 
5. Do not pass amount without user approval. If amount is not passed, use chat function to query for the amount, do not use 100% of balance.
6. Default to chat function if unsure
7. Always use the current balance mentioned
Current USDC Balance: {usdcBalance} USDC
Current USDi Balance: {usdiBalance} USDi
Current SOL Balance: {solBalance} SOL`;

const tools = [
  {
    type: "function" as const,
    function: {
      name: "mint",
      description: "Convert USDC to USDi to start minting",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount of USDC to convert" },
        },
        required: ["amount"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  // {
  //   type: "function" as const,
  //   function: {
  //     name: "balance",
  //     description: "Check wallet balances",
  //     parameters: {
  //       type: "object",
  //       properties: {},
  //       additionalProperties: false,
  //     },
  //     strict: true,
  //   },
  // },
  {
    type: "function" as const,
    function: {
      name: "redeem",
      description: "Convert USDi back to USDC",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount to redeem" },
        },
        required: ["amount"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function" as const,
    function: {
      name: "withdraw",
      description: "Withdraw USDC to another wallet",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount to withdraw" },
          address: {
            type: "string",
            description: "Destination wallet address",
          },
        },
        required: ["amount", "address"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function" as const,
    function: {
      name: "deposit",
      description: "Send the wallet address to the user for deposit",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chat",
      description: "Send a text response to the user",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message to send to user" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  // {
  //   type: "function" as const,
  //   function: {
  //     name: "chat",
  //     description:
  //       "Handle user interaction requiring text responses including questions, information requests, and general conversation",
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         message: {
  //           type: "string",
  //           description: "User's message to process through conversational AI",
  //         },
  //       },
  //       required: ["message"],
  //       additionalProperties: false,
  //     },
  //     strict: true,
  //   },
  // },
];

export async function processMessage(
  ctx: MyContext,
  walletStore: WalletStore,
  chatHistoryStore: ChatHistoryStore
) {
  if (!ctx.message?.text || !ctx.from?.id) return;

  const userId = ctx.from.id.toString();
  // Get current balances
  const solBalance = await walletStore.checkSolBalance(userId);
  const usdcBalance = await walletStore.checkUsdcBalance(userId);
  const usdiBalance = await walletStore.checkUsdiBalance(userId);
  const wallet = walletStore.getWallet(userId);

  // Create system prompt with current data
  const systemPromptWithData = SYSTEM_PROMPT.replace(
    "{walletAddress}",
    wallet?.publicKey || "Not created yet"
  )
    .replace("{usdcBalance}", usdcBalance.toFixed(5))
    .replace("{usdiBalance}", usdiBalance.toFixed(5))
    .replace("{solBalance}", solBalance.toFixed(5));

  // Get chat history and convert to OpenAI message format
  const history = chatHistoryStore.getHistory(userId);
  const messages = [
    ...history.map((msg) => ({
      role: msg.from === "user" ? ("user" as const) : ("assistant" as const),
      content: msg.content,
    })),
    { role: "system" as const, content: systemPromptWithData },
    { role: "user" as const, content: ctx.message.text },
  ];

  console.log(JSON.stringify(messages));
  console.log(
    "Determining if need to call agent or function:",
    ctx.message.text
  );
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      tools,
      tool_choice: "required",
    });
    const toolCall = completion.choices[0].message.tool_calls?.[0];
    const response = completion.choices[0].message.content;
    console.log("Tool call:", toolCall);
    console.log("Response:", response);

    if (toolCall) {
      const args = JSON.parse(toolCall.function.arguments || "{}");
      switch (toolCall.function.name) {
        case "mint":
          await handleMintAmount(ctx, walletStore, args.amount);
          break;
        case "balance":
          await handleBalance(ctx, walletStore);
          break;
        case "redeem":
          await handleConvertAmount(ctx, walletStore, args.amount);
          break;
        case "withdraw":
          await handleWithdrawalAddress(
            ctx,
            walletStore,
            args.address,
            args.amount
          );
          break;
        case "deposit":
          await handleDeposit(ctx, walletStore);
          break;
        case "chat":
          await chat(ctx, args.message);
          break;
      }
    } else if (response) {
      await ctx.reply(response);
    } else {
      await ctx.reply("I couldn't process that request. Please try again.");
    }
  } catch (error) {
    console.error("Error:", error);
    await ctx.reply("Sorry, something went wrong.");
  }
}

async function chatAPI(ctx: MyContext, message: string, userId: string) {
  try {
    const response = await axios.post(
      "https://236652b9de25a4dd44464d1f03593c6321692558-3000.dstack-prod4.phala.network/fd63c924-0b2d-028c-8d05-8caee8cd059b/message",
      {
        text: message,
        userId,
      },
      {
        timeout: 20000,
        timeoutErrorMessage: "Request timed out",
      }
    );
    await ctx.reply(
      response.data[0].text ||
        "Unable to reply right now, please try again later."
    );
    // const completion = await openai.chat.completions.create({
    //   model: "gpt-4o-mini",
    //   messages: [
    //     {
    //       role: "system",
    //       content:
    //         "You are a helpful crypto wallet assistant. Keep responses concise and focused.",
    //     },
    //     { role: "user", content: message },
    //   ],
    // });

    // const response = completion.choices[0].message.content;
    // await ctx.reply(response || "Error processing message");
  } catch (error) {
    console.error("Error processing message:", error);
    await ctx.reply("Sorry, something went wrong.");
  }
}

async function chat(ctx: MyContext, message: string) {
  await ctx.reply(escapeMarkdown(message), {
    parse_mode: "MarkdownV2",
  });
}

export const escapeMarkdown = (text: string) => {
  return text.replace(/[[\]()`>#+\-=|{}.!_\\]/g, "\\$&");
};
