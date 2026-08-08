import { describe, expect, it } from 'vitest';
import { parseUpload } from './use-generator-runtime.js';

describe('reading the backend’s answer to an upload', () => {
  it('takes the name the backend filed it under, which is what a graph must reference', () => {
    // Not the name we sent: ComfyUI renames on collision unless told to overwrite, and a graph
    // pointing at the name we chose would then load a different image.
    expect(parseUpload('{"name":"take_000089.png","type":"input"}')).toEqual({ name: 'take_000089.png' });
  });

  it('keeps a subfolder when there is one, since some nodes need it spelled out', () => {
    expect(parseUpload('{"name":"a.png","subfolder":"clipspace"}')).toEqual({
      name: 'a.png',
      subfolder: 'clipspace',
    });
  });

  it('drops an empty subfolder rather than passing one along', () => {
    expect(parseUpload('{"name":"a.png","subfolder":""}')).toEqual({ name: 'a.png' });
  });

  it('refuses a reply that is not JSON', () => {
    // A reverse proxy in front of the backend answers with HTML when it is unhappy; treating that as
    // a successful upload would submit a graph pointing at nothing.
    expect(parseUpload('<html>502 Bad Gateway</html>')).toBeUndefined();
  });

  it('refuses a reply with no name', () => {
    expect(parseUpload('{"type":"input"}')).toBeUndefined();
    expect(parseUpload('{"name":""}')).toBeUndefined();
  });
});
