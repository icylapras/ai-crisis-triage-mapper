const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const MAX_BUFFERED_AUDIO_BYTES = 1_000_000;

export class LiveVoiceClient {
  constructor({
    url,
    onReady,
    onStatus,
    onTranscript,
    onToolActivity,
    onInterrupted,
    onTurnComplete,
    onError,
    onClose,
  }) {
    this.url = url;
    this.callbacks = {
      onReady,
      onStatus,
      onTranscript,
      onToolActivity,
      onInterrupted,
      onTurnComplete,
      onError,
      onClose,
    };
    this.websocket = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.mediaSource = null;
    this.recorder = null;
    this.muteGain = null;
    this.playbackSources = new Set();
    this.nextPlaybackTime = 0;
    this.recording = false;
    this.intentionalClose = false;
  }

  async start() {
    this.intentionalClose = false;
    this.callbacks.onStatus?.("connecting");

    try {
      await this.initializeAudio();
      await this.connectWebSocket();
      this.recording = true;
      this.callbacks.onStatus?.("listening");
    } catch (error) {
      this.intentionalClose = true;
      this.websocket?.close();
      this.websocket = null;
      this.teardownAudio();
      this.callbacks.onError?.(friendlyVoiceError(error));
      throw error;
    }
  }

  async initializeAudio() {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Audio capture is not supported in this browser.");
    }

    this.audioContext = new AudioContextClass();
    await this.audioContext.audioWorklet.addModule(
      "/pcm-recorder-worklet.js",
    );
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.mediaSource = this.audioContext.createMediaStreamSource(
      this.mediaStream,
    );
    this.recorder = new AudioWorkletNode(
      this.audioContext,
      "pcm-recorder",
    );
    this.muteGain = this.audioContext.createGain();
    this.muteGain.gain.value = 0;

    this.recorder.port.onmessage = ({ data }) => {
      if (!this.recording) return;
      const downsampled = downsample(
        data,
        this.audioContext.sampleRate,
        INPUT_SAMPLE_RATE,
      );
      this.sendAudio(floatToPcm16(downsampled));
    };

    this.mediaSource.connect(this.recorder);
    this.recorder.connect(this.muteGain);
    this.muteGain.connect(this.audioContext.destination);
  }

  connectWebSocket() {
    return new Promise((resolve, reject) => {
      let ready = false;
      const websocket = new WebSocket(this.url);
      websocket.binaryType = "arraybuffer";
      this.websocket = websocket;

      const rejectBeforeReady = (error) => {
        if (!ready) reject(error);
      };

      websocket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.playAudio(event.data);
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === "ready") {
          ready = true;
          this.callbacks.onReady?.(message);
          this.callbacks.onStatus?.("listening");
          resolve();
          return;
        }
        if (message.type === "transcript") {
          this.callbacks.onTranscript?.(message);
          return;
        }
        if (message.type === "tool_activity") {
          this.callbacks.onToolActivity?.(message);
          return;
        }
        if (message.type === "interrupted") {
          this.clearPlayback();
          this.callbacks.onInterrupted?.();
          this.callbacks.onStatus?.("listening");
          return;
        }
        if (message.type === "turn_complete") {
          this.callbacks.onTurnComplete?.();
          this.callbacks.onStatus?.("listening");
          return;
        }
        if (message.type === "session_ending") {
          this.callbacks.onStatus?.("connecting");
          return;
        }
        if (message.type === "error") {
          const error = new Error(message.message);
          this.callbacks.onError?.(message.message);
          rejectBeforeReady(error);
        }
      };

      websocket.onerror = () => {
        rejectBeforeReady(new Error("Could not connect to live voice support."));
      };

      websocket.onclose = () => {
        this.recording = false;
        if (!ready && !this.intentionalClose) {
          reject(new Error("Live voice support closed before it was ready."));
        }
        this.callbacks.onClose?.({ intentional: this.intentionalClose });
      };
    });
  }

  sendAudio(buffer) {
    if (
      !this.websocket ||
      this.websocket.readyState !== WebSocket.OPEN ||
      this.websocket.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES
    ) {
      return;
    }
    this.websocket.send(buffer);
  }

  playAudio(arrayBuffer) {
    if (!this.audioContext || arrayBuffer.byteLength < 2) return;
    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume();
    }

    const pcm = new Int16Array(arrayBuffer);
    const samples = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) {
      samples[index] = pcm[index] / 32768;
    }

    const buffer = this.audioContext.createBuffer(
      1,
      samples.length,
      OUTPUT_SAMPLE_RATE,
    );
    buffer.copyToChannel(samples, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    const now = this.audioContext.currentTime;
    this.nextPlaybackTime = Math.max(now, this.nextPlaybackTime);
    source.start(this.nextPlaybackTime);
    this.nextPlaybackTime += buffer.duration;
    this.playbackSources.add(source);
    this.callbacks.onStatus?.("speaking");

    source.onended = () => {
      this.playbackSources.delete(source);
      if (this.playbackSources.size === 0) {
        this.callbacks.onStatus?.("listening");
      }
    };
  }

  clearPlayback() {
    for (const source of this.playbackSources) {
      try {
        source.stop();
      } catch {
        // A source that already ended cannot be stopped again.
      }
    }
    this.playbackSources.clear();
    if (this.audioContext) {
      this.nextPlaybackTime = this.audioContext.currentTime;
    }
  }

  stop() {
    this.intentionalClose = true;
    this.recording = false;
    this.clearPlayback();

    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "audio_stream_end" }));
      this.websocket.send(JSON.stringify({ type: "close" }));
      this.websocket.close(1000, "Voice mode closed");
    } else {
      this.websocket?.close();
    }
    this.websocket = null;
    this.teardownAudio();
  }

  teardownAudio() {
    this.recording = false;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.mediaSource?.disconnect();
    this.mediaSource = null;
    this.recorder?.disconnect();
    this.recorder = null;
    this.muteGain?.disconnect();
    this.muteGain = null;
    if (this.audioContext && this.audioContext.state !== "closed") {
      void this.audioContext.close();
    }
    this.audioContext = null;
  }
}

function downsample(samples, inputRate, outputRate) {
  if (inputRate === outputRate) return samples;
  if (outputRate > inputRate) {
    throw new Error("Microphone sample rate is below 16 kHz.");
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.round(samples.length / ratio);
  const output = new Float32Array(outputLength);
  let inputOffset = 0;

  for (let outputOffset = 0; outputOffset < outputLength; outputOffset += 1) {
    const nextInputOffset = Math.round((outputOffset + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (
      let index = inputOffset;
      index < nextInputOffset && index < samples.length;
      index += 1
    ) {
      sum += samples[index];
      count += 1;
    }
    output[outputOffset] = count > 0 ? sum / count : 0;
    inputOffset = nextInputOffset;
  }

  return output;
}

function floatToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
}

function friendlyVoiceError(error) {
  if (error?.name === "NotAllowedError") {
    return "Microphone access was blocked. Allow it and try voice mode again.";
  }
  if (error?.name === "NotFoundError") {
    return "No microphone was found. You can still type your report.";
  }
  return error?.message || "Live voice support could not start.";
}
