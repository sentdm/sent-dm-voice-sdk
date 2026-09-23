import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  SentVoiceProvider,
  useActiveCall,
  useAudioDevices,
  useIncomingCall,
  useSentVoice,
} from '@sentdm/voice/react';

test('the provider and every hook render on the server without touching window, document or navigator', () => {
  const touched: string[] = [];
  for (const name of ['window', 'document', 'navigator']) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: () => {
        touched.push(name);
        return undefined;
      },
    });
  }
  const Hooks = () => {
    const { client, state } = useSentVoice();
    const invite = useIncomingCall();
    const { call, duration } = useActiveCall();
    const { inputs, outputs } = useAudioDevices();
    return createElement(
      'p',
      null,
      `${client} ${state} ${invite} ${call} ${duration} ${inputs.length} ${outputs.length}`,
    );
  };

  const html = renderToString(
    createElement(SentVoiceProvider, { tokenProvider: async () => '' }, createElement(Hooks)),
  );

  expect(html).toBe('<p>null unregistered null null 0 0 0</p>');
  expect(touched).toEqual([]);
});
