const SOUNDS = {
  move: 'https://lichess1.org/assets/_bYNRz4/sound/standard/Move.mp3',
  capture: 'https://lichess1.org/assets/_bYNRz4/sound/standard/Capture.mp3',
} as const;

const cache = new Map<string, HTMLAudioElement>();

function getAudio(url: string): HTMLAudioElement {
  let audio = cache.get(url);
  if (!audio) {
    audio = new Audio(url);
    cache.set(url, audio);
  }
  return audio;
}

export function playMoveSound(isCapture: boolean): void {
  const audio = getAudio(isCapture ? SOUNDS.capture : SOUNDS.move);
  audio.currentTime = 0;
  audio.play().catch(() => {});
}
