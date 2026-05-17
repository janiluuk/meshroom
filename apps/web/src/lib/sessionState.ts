export type MixerChannelState = {
  identity: string;
  channel: 1 | 2 | 3 | 4;
  gain: number;
  pan: number;
  mute: boolean;
};

export type RoomSyncState = {
  mixer: MixerChannelState[];
  participantLoops: Record<string, boolean>;
  sessionLoop: boolean;
};

export const defaultRoomSyncState = (): RoomSyncState => ({
  mixer: [],
  participantLoops: {},
  sessionLoop: false
});
