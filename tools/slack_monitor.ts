import { WebClient } from "@slack/web-api";
import { SLACK_BOT_TOKEN } from "../config";

const slack = new WebClient(SLACK_BOT_TOKEN);

export async function slackGetMessages(params: Record<string, any>): Promise<string> {
  const channel: string = params.channel;
  const limit: number = Math.min(parseInt(params.limit) || 10, 100);

  if (!channel) return "missing channel param (e.g. 'general', 'random')";

  try {
    const result = await slack.conversations.history({
      channel,
      limit,
    });

    if (!result.messages || result.messages.length === 0) {
      return `no messages in #${channel}`;
    }

    const formatted = result.messages
      .reverse()
      .map((msg: any) => {
        const user = msg.user || msg.username || "bot";
        const ts = new Date(parseInt(msg.ts || "0") * 1000).toLocaleString();
        return `[${ts}] <@${user}>: ${msg.text || "(no text)"}`;
      })
      .join("\n");

    return `Recent messages in #${channel}:\n${formatted}`;
  } catch (e: any) {
    return `slack error: ${e.message}`;
  }
}

export async function slackListChannels(_params: Record<string, any>): Promise<string> {
  try {
    const result = await slack.conversations.list({
      limit: 20,
      exclude_archived: true,
    });

    if (!result.channels || result.channels.length === 0) {
      return "no channels found";
    }

    const channels = result.channels
      .map((ch: any) => `#${ch.name}`)
      .join(", ");

    return `Channels: ${channels}`;
  } catch (e: any) {
    return `slack error: ${e.message}`;
  }
}

export async function slackPostMessage(params: Record<string, any>): Promise<string> {
  const channel: string = params.channel;
  const text: string = params.text;

  if (!channel || !text) return "missing channel or text param";

  try {
    await slack.chat.postMessage({ channel, text });
    return `posted to #${channel}`;
  } catch (e: any) {
    return `slack error: ${e.message}`;
  }
}
