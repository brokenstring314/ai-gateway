import type { IPlugin, PluginContext, PluginResult } from "../types.js";
import type { ChatCompletionRequest, ChatMessage } from "../../providers/types.js";

export interface WordFilterConfig {
  readonly blocklist: string[];
  readonly mode: "reject" | "redact";
}

export class WordFilterPlugin implements IPlugin {
  readonly name = "word-filter";
  readonly stage = "before_request" as const;

  constructor(private readonly config: WordFilterConfig) {}

  async execute(ctx: PluginContext): Promise<PluginResult> {
    const blocked = this.messagesContainBlockedWord(ctx.request.messages);

    if (!blocked) {
      return { action: "continue" };
    }

    if (this.config.mode === "reject") {
      return { action: "reject", reason: "Content blocked by word filter" };
    }

    // Redact mode: replace blocked words in all messages
    const redactedMessages = ctx.request.messages.map((msg) => this.redactMessage(msg));
    const newRequest: ChatCompletionRequest = {
      ...ctx.request,
      messages: redactedMessages,
    };

    return { action: "modify", request: newRequest };
  }

  private messagesContainBlockedWord(messages: ChatCompletionRequest["messages"]): boolean {
    for (const msg of messages) {
      if (typeof msg.content === "string" && this.containsBlockedWord(msg.content)) {
        return true;
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.text !== undefined && this.containsBlockedWord(part.text)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private containsBlockedWord(text: string): boolean {
    const lower = text.toLowerCase();
    return this.config.blocklist.some((word) => lower.includes(word.toLowerCase()));
  }

  private redactMessage(msg: ChatMessage): ChatMessage {
    if (typeof msg.content === "string") {
      return { ...msg, content: this.redactText(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map((part) => {
        if (part.text !== undefined) {
          return { ...part, text: this.redactText(part.text) };
        }
        return part;
      });
      return { ...msg, content: parts };
    }
    return msg;
  }

  private redactText(text: string): string {
    let result = text;
    for (const word of this.config.blocklist) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "gi"), "***");
    }
    return result;
  }
}
