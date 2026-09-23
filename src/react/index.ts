/// <reference lib="dom" />
'use client';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type Context,
  type ReactElement,
  type ReactNode,
} from 'react';
import { SentVoice, type SentVoiceOptions } from '../index';

interface SentVoiceProviderProps extends SentVoiceOptions {
  /**
   * Registers as soon as the client is created.
   *
   * @default true
   */
  autoRegister?: boolean | undefined;
  children?: ReactNode;
}

const clientEvents = ['registering', 'registered', 'unregistered', 'offline'] as const;
const callEvents = [
  'ringing',
  'answered',
  'connected',
  'reconnecting',
  'reconnected',
  'muteChanged',
] as const;

const ClientContext = createContext<SentVoice | null | undefined>(undefined);
const InviteContext = createContext<SentVoice.CallInvite | null | undefined>(undefined);

function useProvided<T>(context: Context<T | undefined>): T {
  const value = useContext(context);
  if (value === undefined) throw new Error('The voice hooks must be used inside a SentVoiceProvider.');
  return value;
}

/**
 * Creates one `SentVoice` client once mounted and destroys it on unmount; children render before the
 * client exists. The props are read when the client is created, except `tokenProvider`, which is always
 * the latest one, so remount with a new `key` to change them. Supports React 18 and 19.
 */
export function SentVoiceProvider({
  autoRegister = true,
  children,
  ...options
}: SentVoiceProviderProps): ReactElement {
  const [client, setClient] = useState<SentVoice | null>(null);
  const [invites, setInvites] = useState<SentVoice.CallInvite[]>([]);
  const tokenProvider = useRef(options.tokenProvider);

  useEffect(() => {
    tokenProvider.current = options.tokenProvider;
  });

  useEffect(() => {
    const client = new SentVoice({ ...options, tokenProvider: () => tokenProvider.current() });
    client.on('incomingCall', (invite) => {
      const settled = () => setInvites((pending) => pending.filter((other) => other !== invite));
      invite.on('accepted', settled).on('rejected', settled).on('cancelled', settled);
      setInvites((pending) => [...pending, invite]);
    });
    setClient(client);
    return () => void client.destroy();
  }, []);

  useEffect(() => {
    if (client && autoRegister) client.register().catch(() => {});
  }, [client]);

  return createElement(
    ClientContext.Provider,
    { value: client },
    createElement(InviteContext.Provider, { value: invites[invites.length - 1] ?? null }, children),
  );
}

/** The client, `null` until it is created, with `register` and `unregister`, which do nothing until then. */
export function useSentVoice(): {
  client: SentVoice | null;
  state: SentVoice.ClientState;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
} {
  const client = useProvided(ClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!client) return () => {};
      for (const event of clientEvents) client.on(event, onChange);
      return () => {
        for (const event of clientEvents) client.off(event, onChange);
      };
    },
    [client],
  );
  const state = useSyncExternalStore<SentVoice.ClientState>(
    subscribe,
    () => client?.state ?? 'unregistered',
    () => 'unregistered',
  );
  const register = useCallback(async () => {
    await client?.register();
  }, [client]);
  const unregister = useCallback(async () => {
    await client?.unregister();
  }, [client]);
  return { client, state, register, unregister };
}

/** The newest incoming call still waiting for an answer, or `null`. */
export function useIncomingCall(): SentVoice.CallInvite | null {
  return useProvided(InviteContext);
}

/**
 * The active call and its controls, which do nothing without one. `duration` counts the seconds since the
 * call connected and ticks every second while it is connected.
 */
export function useActiveCall(): {
  call: SentVoice.Call | null;
  state: SentVoice.CallState | null;
  isMuted: boolean;
  mute: (muted?: boolean) => void;
  hangup: () => Promise<void>;
  sendDigits: (digits: string) => void;
  duration: number;
} {
  const client = useProvided(ClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!client) return () => {};
      client.on('activeCallChanged', onChange);
      return () => {
        client.off('activeCallChanged', onChange);
      };
    },
    [client],
  );
  const call = useSyncExternalStore(
    subscribe,
    () => client?.activeCall ?? null,
    () => null,
  );
  const subscribeCall = useCallback(
    (onChange: () => void) => {
      if (!call) return () => {};
      for (const event of callEvents) call.on(event, onChange);
      return () => {
        for (const event of callEvents) call.off(event, onChange);
      };
    },
    [call],
  );
  const state = useSyncExternalStore(
    subscribeCall,
    () => call?.state ?? null,
    () => null,
  );
  const isMuted = useSyncExternalStore(
    subscribeCall,
    () => call?.isMuted ?? false,
    () => false,
  );
  const [, tick] = useReducer((ticks: number) => ticks + 1, 0);

  useEffect(() => {
    if (state !== 'connected') return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state]);

  const startedAt = call?.startedAt;
  const duration = startedAt === undefined ? 0 : Math.floor((Date.now() - startedAt) / 1000);
  const mute = useCallback(
    (muted?: boolean) => {
      call?.mute(muted);
    },
    [call],
  );
  const hangup = useCallback(async () => {
    await call?.hangup();
  }, [call]);
  const sendDigits = useCallback(
    (digits: string) => {
      call?.sendDigits(digits);
    },
    [call],
  );
  return { call, state, isMuted, mute, hangup, sendDigits, duration };
}

/**
 * The microphones and speakers, listed again on every device change, with `setInput` and `setOutput`,
 * which do nothing until the client is created. The lists stay empty where the browser cannot list devices.
 */
export function useAudioDevices(): {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  setInput: (deviceId: string) => Promise<void>;
  setOutput: (deviceId: string) => Promise<void>;
} {
  const client = useProvided(ClientContext);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!client) return;
    const { audio } = client;
    const list = () => {
      Promise.all([audio.inputDevices(), audio.outputDevices()]).then(
        ([inputDevices, outputDevices]) => {
          setInputs(inputDevices);
          setOutputs(outputDevices);
        },
        () => {},
      );
    };
    list();
    audio.on('deviceChanged', list);
    return () => {
      audio.off('deviceChanged', list);
    };
  }, [client]);

  const setInput = useCallback(
    async (deviceId: string) => {
      await client?.audio.setInputDevice(deviceId);
    },
    [client],
  );
  const setOutput = useCallback(
    async (deviceId: string) => {
      await client?.audio.setOutputDevice(deviceId);
    },
    [client],
  );
  return { inputs, outputs, setInput, setOutput };
}
