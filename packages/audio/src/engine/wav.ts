/**
 * A rendered mix, as a file the encoder will accept.
 *
 * WAV rather than anything cleverer, for one reason: it is the format that needs no encoder. The mix is
 * handed to ffmpeg, which re-encodes it to AAC or Opus anyway, so compressing here would mean encoding
 * twice and losing something both times for no gain in a file that exists for a few seconds.
 *
 * 16-bit rather than float32 for the same kind of reason — every tool reads it, it halves the temporary
 * file, and the mix is bound for a lossy codec whose noise floor is far above the 16-bit one.
 */

/** The minimum of an `AudioBuffer` this needs, so encoding is testable without a browser. */
export interface RenderedAudio {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;

/**
 * Encodes a rendered mix as a 16-bit PCM WAV.
 *
 * Samples are **clamped** to the representable range rather than allowed to wrap. A mix that peaks above
 * unity is a mistake the user can hear as loudness; one that wraps is a mistake they hear as a
 * destructive crackle, and the difference between the two is a single `Math.min`.
 */
export function encodeWav(audio: RenderedAudio): Uint8Array {
  const channels = Math.max(1, audio.numberOfChannels);
  const frames = audio.length;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;

  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, 'RIFF');
  // Everything after this field, which is why it is the total minus the eight bytes of `RIFF` + size.
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  // Interleaved, which is what WAV means by a frame: all channels of sample 0, then all of sample 1.
  const data: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) data.push(audio.getChannelData(channel));

  let offset = HEADER_BYTES;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = data[channel]?.[frame] ?? 0;
      view.setInt16(offset, toPcm16(sample), true);
      offset += bytesPerSample;
    }
  }

  return bytes;
}

/**
 * One float sample as signed 16-bit.
 *
 * The asymmetry is deliberate and correct: two's complement runs −32768 to +32767, so scaling both
 * directions by 32768 would let +1.0 overflow to −32768 — a full-scale peak rendered as its own
 * inverse, which is the loudest possible click.
 */
function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/** How long an encoded mix will be, for a caller deciding whether it is worth writing. */
export function wavByteLength(frames: number, channels: number): number {
  return HEADER_BYTES + frames * channels * (BITS_PER_SAMPLE / 8);
}
