import { describe, expect, it } from 'vitest';
import { type RenderedAudio, encodeWav, wavByteLength } from './wav.js';

/**
 * The rendered mix, as a file the encoder accepts.
 *
 * Every assertion here is about a byte nobody can see. A wrong header field produces a file ffmpeg
 * refuses; a wrong sample conversion produces one it accepts and plays as a crackle.
 */

function audio(channels: readonly (readonly number[])[], sampleRate = 48_000): RenderedAudio {
  const data = channels.map((channel) => Float32Array.from(channel));
  return {
    numberOfChannels: data.length,
    sampleRate,
    length: data[0]?.length ?? 0,
    getChannelData: (channel) => data[channel] ?? new Float32Array(0),
  };
}

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.slice(at, at + length));

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe('the header', () => {
  it('is a RIFF/WAVE file', () => {
    const bytes = encodeWav(audio([[0, 0]]));
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(ascii(bytes, 36, 4)).toBe('data');
  });

  it('declares uncompressed PCM, which is the whole point of choosing WAV', () => {
    expect(view(encodeWav(audio([[0]]))).getUint16(20, true)).toBe(1);
    expect(view(encodeWav(audio([[0]]))).getUint16(34, true)).toBe(16);
  });

  it('states the size of everything after the size field itself', () => {
    // Off by the eight bytes of `RIFF` plus the field, which is the classic way to write a file every
    // player rejects.
    const bytes = encodeWav(audio([[0, 0, 0]]));
    expect(view(bytes).getUint32(4, true)).toBe(bytes.length - 8);
  });

  it('carries the rate, the channel count and the derived block figures', () => {
    const bytes = encodeWav(audio([[0], [0]], 44_100));
    const data = view(bytes);
    expect(data.getUint16(22, true)).toBe(2);
    expect(data.getUint32(24, true)).toBe(44_100);
    expect(data.getUint16(32, true)).toBe(4); // two channels of two bytes
    expect(data.getUint32(28, true)).toBe(44_100 * 4);
  });

  it('agrees with what a caller can compute in advance', () => {
    expect(encodeWav(audio([[0], [0]])).length).toBe(wavByteLength(1, 2));
  });
});

describe('the samples', () => {
  it('interleaves the channels, which is what a WAV frame means', () => {
    // Left 1, 3 and right 2, 4 must come out 1, 2, 3, 4 — not 1, 3, 2, 4.
    const bytes = encodeWav(
      audio([
        [0.1, 0.3],
        [0.2, 0.4],
      ]),
    );
    const data = view(bytes);
    const at = (index: number): number => data.getInt16(44 + index * 2, true) / 0x7fff;
    expect(at(0)).toBeCloseTo(0.1, 3);
    expect(at(1)).toBeCloseTo(0.2, 3);
    expect(at(2)).toBeCloseTo(0.3, 3);
    expect(at(3)).toBeCloseTo(0.4, 3);
  });

  it('renders a full-scale peak as the loudest positive sample, not as its inverse', () => {
    // Scaling both directions by 32768 lets +1.0 overflow to −32768, which is the loudest possible
    // click sitting exactly where the music was loudest.
    expect(view(encodeWav(audio([[1]]))).getInt16(44, true)).toBe(32767);
    expect(view(encodeWav(audio([[-1]]))).getInt16(44, true)).toBe(-32768);
  });

  it('clamps rather than wraps when the mix goes over unity', () => {
    // Over unity is a mistake the user hears as loudness. Wrapping is one they hear as destruction.
    expect(view(encodeWav(audio([[1.6]]))).getInt16(44, true)).toBe(32767);
    expect(view(encodeWav(audio([[-1.6]]))).getInt16(44, true)).toBe(-32768);
  });

  it('writes silence as exact zero', () => {
    expect(view(encodeWav(audio([[0, 0]]))).getInt16(44, true)).toBe(0);
  });

  it('handles a mix with no samples at all, rather than producing a broken header', () => {
    const bytes = encodeWav(audio([[]]));
    expect(bytes.length).toBe(44);
    expect(view(bytes).getUint32(40, true)).toBe(0);
  });
});
