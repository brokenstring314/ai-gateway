import type { IPlugin, PluginContext, PluginResult } from "../types.js";
import type { ChatCompletionRequest, ChatMessage } from "../../providers/types.js";

export interface WordFilterConfig {
  readonly blocklist: string[];
  readonly mode: "reject" | "redact";
}

/**
 * Text is compared in one canonical form: Unicode NFKC (folds compatibility
 * characters such as the Kelvin sign U+212A, fullwidth letters and
 * ligatures) and then lower-cased. Redaction runs on the NFKC text with a
 * Unicode-aware case-insensitive RegExp, and if a blocked word is still
 * detected after redaction the request is rejected instead of being
 * forwarded unchanged.
 *
 * Substring filters remain bypassable (zero-width characters, homoglyphs
 * from other scripts); treat this plugin as a coarse filter, not a security
 * boundary.
 */
function canonical(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class WordFilterPlugin implements IPlugin {
  readonly name = "word-filter";
  readonly stage = "before_request" as const;
  private readonly canonicalWords: string[];
  private readonly redactPatterns: RegExp[];

  constructor(private readonly config: WordFilterConfig) {
    const words = config.blocklist.filter((w) => typeof w === "string" && w !== "");
    this.canonicalWords = words.map(canonical);
    this.redactPatterns = words.map((w) => new RegExp(escapeRegExp(w.normalize("NFKC")), "giu"));
  }

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
    // Detection and redaction disagree (some case/normalization edge the
    // RegExp cannot express): never forward the blocked word, reject instead.
    if (this.messagesContainBlockedWord(redactedMessages)) {
      return { action: "reject", reason: "Content blocked by word filter" };
    }
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
    if (this.canonicalWords.length === 0) return false;
    const normalized = canonical(text);
    return this.canonicalWords.some((word) => normalized.includes(word));
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

  /** Text without a blocked word is returned untouched; otherwise its NFKC form, redacted. */
  private redactText(text: string): string {
    if (!this.containsBlockedWord(text)) return text;
    let result = text.normalize("NFKC");
    for (const pattern of this.redactPatterns) {
      result = result.replace(pattern, "***");
    }
    return result;
  }
}
