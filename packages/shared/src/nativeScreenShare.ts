export interface LiveKitScreenTokenRequest {
  /** Exactly one room locator, resolved on the API instance receiving this request. */
  channelId?: string;
  dmChannelId?: string;
  federatedCallId?: string;
  /** The existing Web Room's localParticipant.identity, never a helper identity. */
  ownerIdentity: string;
}

export interface LiveKitScreenTokenResponse {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  ownerIdentity: string;
  voiceToken: string;
  voiceIdentity: string;
}

export interface NativeParticipantMetadata {
  purpose: 'screen-share' | 'native-voice';
  ownerIdentity: string;
}

export interface LiveKitScreenStopRequest {
  /** The screen identity returned by screen-token; stops both native participants. */
  identity: string;
}
