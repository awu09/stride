// Two voice backends with the same shape:
//  - GrokVoice: full-duplex conversation with xAI's realtime voice agent (via our server proxy).
//  - BrowserVoice: Web Speech API fallback when no xAI key is configured.

const RATE = 24000;

// ---------- browser text-to-speech ----------
let preferredVoice = null;
function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  preferredVoice =
    voices.find((v) => /en-US/.test(v.lang) && /Samantha|Google US English|Jenny|Aria/i.test(v.name)) ||
    voices.find((v) => /^en/.test(v.lang)) ||
    null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

export function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  if (preferredVoice) u.voice = preferredVoice;
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

// ---------- audio helpers ----------
function makeResampler(inRate, outRate) {
  const ratio = inRate / outRate;
  let t = 0; // fractional read position; -1 refers to the last sample of the previous chunk
  let last = 0;
  return (input) => {
    const n = input.length;
    const out = new Int16Array(Math.ceil(n / ratio) + 2);
    let k = 0;
    while (t < n - 1) {
      const i = Math.floor(t);
      const f = t - i;
      const a = i < 0 ? last : input[i];
      const v = Math.max(-1, Math.min(1, a + (input[i + 1] - a) * f));
      out[k++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      t += ratio;
    }
    t -= n;
    last = input[n - 1];
    return out.subarray(0, k);
  };
}

function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length & ~1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ---------- Grok realtime voice ----------
export class GrokVoice {
  constructor({ voice = 'eve', instructions, tools, handleTool, onState, onUserText, onAssistantText, onError }) {
    Object.assign(this, { voice, instructions, tools, handleTool, onState, onUserText, onAssistantText, onError });
    this.state = 'off';
    this.listening = false;
    this.sources = new Set();
    this.playhead = 0;
    this.pendingTools = [];
    this.outBuffer = [];
    this.outSamples = 0;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setState(state) {
    this.state = state;
    this.onState?.(state);
  }

  async start() {
    this.setState('connecting');
    this.ctx = new AudioContext();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('/js/mic-worklet.js');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-capture');
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    source.connect(this.node).connect(sink).connect(this.ctx.destination);
    const resample = makeResampler(this.ctx.sampleRate, RATE);
    this.node.port.onmessage = (e) => {
      if (!this.listening || !this.connected) return;
      const pcm = resample(e.data);
      this.outBuffer.push(pcm);
      this.outSamples += pcm.length;
      if (this.outSamples >= RATE / 10) this.flushMic(); // ~100 ms chunks
    };

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/realtime`);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onclose = (e) => reject(new Error(e.reason || 'Voice connection closed'));
    });
    this.ws.onmessage = (e) => this.onEvent(JSON.parse(e.data));
    this.ws.onclose = (e) => {
      this.listening = false;
      this.stopPlayback();
      this.setState('off');
      if (e.code !== 1000 || e.reason) this.onError?.(`Voice disconnected${e.reason ? `: ${e.reason}` : ''}`);
    };

    this.send({
      type: 'session.update',
      session: {
        voice: this.voice,
        instructions: this.instructions,
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: RATE } },
          output: { format: { type: 'audio/pcm', rate: RATE } },
        },
        tools: this.tools,
      },
    });
    this.listening = true;
    this.setState('listening');
  }

  send(event) {
    if (this.connected) this.ws.send(JSON.stringify(event));
  }

  flushMic() {
    const merged = new Int16Array(this.outSamples);
    let offset = 0;
    for (const chunk of this.outBuffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.outBuffer = [];
    this.outSamples = 0;
    this.send({ type: 'input_audio_buffer.append', audio: toBase64(merged) });
  }

  setListening(on) {
    this.listening = on;
    if (!on) {
      this.outBuffer = [];
      this.outSamples = 0;
      this.send({ type: 'input_audio_buffer.clear' });
    }
    if (this.state !== 'speaking') this.setState(on ? 'listening' : 'muted');
  }

  // Speak a scripted line (turn cues, mile splits). Grok voices it as its own turn.
  say(text) {
    if (!this.connected) return false;
    this.send({
      type: 'conversation.item.create',
      item: { type: 'force_message', role: 'assistant', interruptible: true, content: [{ type: 'output_text', text }] },
    });
    this.onAssistantText?.(text, true);
    return true;
  }

  sendText(text) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' });
  }

  async onEvent(e) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        this.stopPlayback(); // let the runner barge in
        this.onUserText?.('…', false);
        break;
      case 'conversation.item.input_audio_transcription.updated':
      case 'conversation.item.input_audio_transcription.delta':
        if (e.transcript) this.onUserText?.(e.transcript, false);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) this.onUserText?.(e.transcript, true);
        break;
      case 'response.created':
        this.responseText = '';
        break;
      case 'response.text.delta':
      case 'response.output_text.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.responseText = (this.responseText || '') + (e.delta || '');
        this.onAssistantText?.(this.responseText, false);
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (e.delta) this.play(fromBase64(e.delta));
        break;
      case 'response.function_call_arguments.done':
        this.pendingTools.push(this.runTool(e));
        break;
      case 'response.done':
        if (this.pendingTools.length) {
          const calls = this.pendingTools;
          this.pendingTools = [];
          await Promise.all(calls);
          await this.playbackFinished(4000);
          this.send({ type: 'response.create' });
        }
        break;
      case 'error':
      case 'proxy.error':
        console.warn('[grok]', e);
        this.onError?.(e.error?.message || e.message || 'Voice error');
        break;
      default:
        break;
    }
  }

  async runTool({ name, call_id: callId, arguments: rawArgs }) {
    let result;
    try {
      const args = rawArgs ? JSON.parse(rawArgs) : {};
      result = await this.handleTool(name, args);
    } catch (err) {
      result = { error: err.message };
    }
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result ?? { ok: true }) },
    });
  }

  play(pcm) {
    const buffer = this.ctx.createBuffer(1, pcm.length, RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.03, this.playhead);
    src.start(at);
    this.playhead = at + buffer.duration;
    this.sources.add(src);
    if (this.state !== 'speaking') this.setState('speaking');
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) {
        this.setState(this.listening ? 'listening' : 'muted');
        this.drained?.();
      }
    };
  }

  playbackFinished(maxMs) {
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, maxMs);
      this.drained = () => {
        clearTimeout(timer);
        this.drained = null;
        resolve();
      };
    });
  }

  stopPlayback() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.playhead = 0;
  }

  stop() {
    this.ws?.close(1000);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.setState('off');
  }
}

// ---------- Web Speech fallback ----------
export class BrowserVoice {
  constructor({ handleCommand, onState, onUserText, onAssistantText }) {
    Object.assign(this, { handleCommand, onState, onUserText, onAssistantText });
    this.Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  }

  get supported() {
    return Boolean(this.Recognition);
  }

  listenOnce() {
    if (!this.supported) {
      this.onAssistantText?.("Voice input isn't supported in this browser. Try Chrome, or type below.", true);
      return;
    }
    if (this.rec) {
      this.rec.stop();
      return;
    }
    window.speechSynthesis?.cancel();
    const rec = new this.Recognition();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.onState?.('listening');
    rec.onresult = async (e) => {
      const result = e.results[e.results.length - 1];
      const text = result[0].transcript;
      this.onUserText?.(text, result.isFinal);
      if (result.isFinal) {
        this.onState?.('thinking');
        const reply = await this.handleCommand(text);
        if (reply) this.say(reply);
      }
    };
    rec.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.onAssistantText?.(`Mic error: ${e.error}`, true);
    };
    rec.onend = () => {
      this.rec = null;
      this.onState?.('off');
    };
    rec.start();
  }

  say(text) {
    speak(text);
    this.onAssistantText?.(text, true);
  }
}
