import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { captureSelectedWindow } from '../src/domain/computerCapture.js';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFileReader = globalThis.FileReader;
const originalMediaElement = globalThis.HTMLMediaElement;

function installCaptureMocks({ displaySurface = 'window', imageBytes = 256 } = {}) {
  const constraints = [];
  let stopped = 0;
  const track = {
    label: 'Selected application window',
    getSettings: () => ({ displaySurface }),
    stop: () => { stopped += 1; },
  };
  globalThis.window = { __TAURI_INTERNALS__: undefined };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getDisplayMedia: async (options) => {
      constraints.push(options);
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    } } },
  });
  globalThis.document = {
    createElement: (tag) => tag === 'video'
      ? { readyState: 2, videoWidth: 640, videoHeight: 480, play: async () => {}, srcObject: null }
      : { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }),
          toBlob: (callback) => callback(new Blob([Buffer.alloc(imageBytes)], { type: 'image/png' })) },
  };
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      this.result = `data:image/png;base64,${Buffer.alloc(blob.size).toString('base64')}`;
      this.onload();
    }
  };
  return { constraints, get stopped() { return stopped; } };
}

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.FileReader = originalFileReader;
  globalThis.HTMLMediaElement = originalMediaElement;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
});

test('capture requests one window and rejects monitor or tab surfaces, stopping the stream', async () => {
  for (const displaySurface of ['monitor', 'browser']) {
    const capture = installCaptureMocks({ displaySurface });

    await assert.rejects(captureSelectedWindow(), /Select a single application window/);

    assert.equal(capture.constraints.length, 1);
    assert.equal(capture.constraints[0].video.displaySurface, 'window');
    assert.equal(capture.constraints[0].monitorTypeSurfaces, 'exclude');
    assert.equal(capture.constraints[0].audio, false);
    assert.equal(capture.stopped, 1);
  }
});

test('a selected window returns a screenshot and releases capture resources', async () => {
  const capture = installCaptureMocks();

  const observation = await captureSelectedWindow();

  assert.equal(observation.application, 'Selected window');
  assert.equal(observation.windowTitle, 'Selected application window');
  assert.equal(observation.accessibilityText, '');
  assert.ok(observation.imageBase64.length > 0);
  assert.equal(capture.stopped, 1);
});

test('oversized screenshots are rejected and the capture stream is still stopped', async () => {
  const capture = installCaptureMocks({ imageBytes: 5 * 1024 * 1024 + 1 });

  await assert.rejects(captureSelectedWindow(), /image is too large/);

  assert.equal(capture.stopped, 1);
});
