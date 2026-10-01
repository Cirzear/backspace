/** The room locator is exclusive, matching the server's screen-token boundary. */
export type NativeScreenRoomLocator =
  | { channelId: string; dmChannelId?: never; federatedCallId?: never }
  | { dmChannelId: string; channelId?: never; federatedCallId?: never }
  | { federatedCallId: string; channelId?: never; dmChannelId?: never };

export interface NativeScreenTokenResponse {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  ownerIdentity: string;
  voiceToken: string;
  voiceIdentity: string;
}
